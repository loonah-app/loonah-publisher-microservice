// index.ts

import amqp from 'amqplib';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { connectToDB } from "./db/connection";
import Project from "./db/models/Project";

dotenv.config();

const execAsync = util.promisify(exec);

// Configuration
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const WALRUS_CONFIG_PATH = process.env.WALRUS_CONFIG_PATH || './walrus/builder-example.yaml';
const QUEUE_NAME = process.env.QUEUE_NAME || 'walrus_publishing';

// GitHub operations
async function cloneRepository(repoUrl: string, branch: string, destPath: string, accessToken: string) {
    const repoUrlWithToken = repoUrl.replace('https://', `https://x-access-token:${accessToken}@`);
    try {
        await execAsync(`git clone --single-branch --branch ${branch} ${repoUrlWithToken} ${destPath}`);
    } catch (error) {
        console.error('Error cloning repository:', error);
        throw error; // Re-throw the error to be caught by the caller
    }
}

// Build operations
async function buildProject(projectPath: string) {
    try {
        const { stdout, stderr } = await execAsync('npm install && npm run build', { cwd: projectPath });
        console.log('Build Output:', stdout);
        console.error('Build Errors:', stderr);
    } catch (error) {
        console.error('Error during build:', error);
        throw error; // Re-throw the error to be caught by the caller
    }
}

// Walrus operations
async function publishToWalrus(configPath: string, buildPath: string) {
    console.log('Publishing to Walrus...');
    const { stdout } = await execAsync(`./walrus/site-builder --config ${configPath} publish ${buildPath}`);
    const walrusUrl = stdout.match(/Browse the resulting site at: (.*)/)?.[1];
    const walrusObjectId = stdout.match(/New site object ID: (.*)/)?.[1];
    if (!walrusUrl || !walrusObjectId) {
        throw new Error('Failed to extract Walrus URL or Object ID from output');
    }
    return { walrusUrl, walrusObjectId };
}

async function publishUpdateToWalrus(configPath: string, buildPath: string, objectId: string) {
    console.log('Publishing update to Walrus...');
    const { stdout } = await execAsync(`./walrus/site-builder --config ${configPath} update ${buildPath} ${objectId}`);
    const walrusUrl = stdout.match(/Browse the resulting site at: (.*)/)?.[1];
    const walrusObjectId = stdout.match(/Site object ID: (.*)/)?.[1];
    if (!walrusUrl || !walrusObjectId) {
        throw new Error('Failed to extract Walrus URL or Object ID from output');
    }
    return { walrusUrl, walrusObjectId };
}

// Message processing
async function processMessage(msg: amqp.ConsumeMessage | null) {
    if (msg === null) return;

    const data = JSON.parse(msg.content.toString());
    const { projectId, branch: branch_, accessToken, projectType: projectType_, updateObjectId } = data;

    console.log(`Processing project: ${projectId}`);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walrus-build-'));

    // Connect to MongoDB and fetch the project
    await connectToDB(); // Ensure the DB connection is established
    const project = await Project.findById(projectId);

    if (!project || !project.githubRepo) {
        console.error(`Project ${projectId} not found or no GitHub repo specified`);
        return;
    }

    const repoUrl = project.githubRepo;
    const branch = branch_ || 'master';
    const projectType = projectType_ || 'react'

    try {
        // Clone repository
        console.log('Cloning repository...');
        await cloneRepository(repoUrl, branch, tempDir, accessToken);

        project.status = 'BUILDING';
        await project.save();

        // Build project
        console.log('Building project...');
        await buildProject(tempDir);

        project.status = 'DEPLOYING';
        await project.save();

        // Determine build output path based on project type
        const buildPath = projectType === 'vue'
            ? path.join(tempDir, 'dist')
            : path.join(tempDir, 'build');

        // Publish to Walrus
        const { walrusUrl, walrusObjectId } = updateObjectId.length === 0 ?
            await publishToWalrus(WALRUS_CONFIG_PATH, buildPath) :
            await publishUpdateToWalrus(WALRUS_CONFIG_PATH, buildPath, updateObjectId);

        // Update database
        console.log('Updating database...');
        project.status = 'DEPLOYED';
        project.tempDomain = walrusUrl;
        project.storageObjectId = walrusObjectId;
        await project.save();

        console.log(`Project ${projectId} published successfully`);
    } catch (error) {
        console.error(`Error processing project ${projectId}:`, error);
        project.status = 'failed';
        await project.save();
    } finally {
        // Clean up
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

// Main function
async function main() {
    console.log('Starting Walrus Publisher Service...');

    // Connect to RabbitMQ
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    // Assert queue
    await channel.assertQueue(QUEUE_NAME, { durable: true });

    // Set prefetch
    channel.prefetch(1);

    console.log('Waiting for messages...');

    // Consume messages
    channel.consume(QUEUE_NAME, async (msg) => {
        try {
            await processMessage(msg);
            channel.ack(msg!);
        } catch (error) {
            console.error('Error processing message:', error);
            // Nack the message and requeue it
            channel.nack(msg!, false, true);
        }
    });

    // Handle application shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down...');
        await channel.close();
        await connection.close();
        process.exit(0);
    });
}

// Run the service
main().catch(console.error);
