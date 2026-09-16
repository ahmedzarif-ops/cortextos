import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePaths } from '../utils/paths.js';
import { notifyAgent } from '../bus/agents.js';

export const notifyAgentCommand = new Command('notify-agent')
  .description('Send an urgent notification to an agent')
  .argument('<name>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <agent>', 'Sender agent name', 'cli')
  .option('--instance <id>', 'Instance ID', 'default')
  .action((name: string, message: string, options: { from: string; instance: string }) => {
    const paths = resolvePaths(options.from, options.instance);
    const ctxRoot = join(homedir(), '.cortextos', options.instance);

    // This QUEUES a signal (a file the daemon polls, plus a bus message). It does not
    // deliver anything, so it must not claim to — see the note on `notifyAgent`.
    const outcome = notifyAgent(paths, options.from, name, message, ctxRoot);
    console.log(`Urgent signal QUEUED for ${name}:`);
    console.log(`  signal file: written`);
    console.log(`  message bus: ${outcome.busQueued ? 'queued' : `FAILED — ${outcome.busError ?? 'unknown error'}`}`);
    console.log(
      `  NOTE: this confirms the signal was QUEUED, not that ${name} received, read ` +
      `or acted on it. The daemon injects it on a later poll.`,
    );
    if (!outcome.busQueued) {
      process.exitCode = 1;
    }
  });
