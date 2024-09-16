import { execFile } from "child_process"
import { promisify } from "util";

const execFileAsync = promisify(execFile)

async function main() {
    try {
        const { stdout } = await execFileAsync('./walrus/site-builder', [
            '--config',
            './walrus/builder-example.yaml',
            'publish',
            './testsite'
        ]);

        const walrusUrl = stdout.match(/Browse the resulting site at: (.*)/)?.[1];
        const walrusObjectId = stdout.match(/New site object ID: (.*)/)?.[1];

        if (!walrusUrl || !walrusObjectId) {
            throw new Error('Failed to extract Walrus URL or Object ID from output');
        }

        // console.log("Success:", stdout)
        console.log({ walrusUrl, walrusObjectId })
    } catch (error) {
        throw new Error(error as any)
    }
}

main().catch((e) => {
    console.log("Error:", e)
})