const firstArg = process.argv[2];
const args = process.argv.slice(2);

function printHelp(): void {
  const bin = process.argv[1]?.split('/').pop() || 'airlinkd';
  console.log(`Airlink daemon

Usage:
  ${bin}              Run the supervised TUI (starts the daemon, shows logs)
  ${bin} start        Run the daemon headless. This is the default command.
  ${bin} configure --panel <url> --key <key>
  ${bin} --help

Commands:
  start       Run the daemon. This is the default when a command is given.
  configure   Write .env values for the panel host and daemon key.

Options:
  -h, --help  Show this help.

Examples:
  ${bin}
  ${bin} start
  ${bin} configure --panel http://panel.example.com:3000 --key your-node-key
  ${bin} configure -p http://localhost:3000 -k your-node-key`);
}

export async function runDaemon(cliArgs: string[]): Promise<void> {
  const first = cliArgs[0];

  if (first === 'help' || cliArgs.includes('-help') || cliArgs.includes('--help') || cliArgs.includes('-h')) {
    if (first === 'configure') {
      const { printConfigureHelp } = await import('./configure');
      printConfigureHelp();
    } else {
      printHelp();
    }
    process.exit(0);
  }

  if (first === 'configure') {
    const { runConfigure } = await import('./configure');
    await runConfigure(cliArgs.slice(1));
    process.exit(0);
  }

  if (first && first !== 'start') {
    console.error(`Unknown command: ${first}`);
    console.log('Run with --help to see the available commands.');
    process.exit(1);
  }

  await import('./protobufLong');
  await import('./bootstrap');
  await import('./server');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const { runTui } = await import("./tui");
    await runTui();
  } else {
    await runDaemon(args);
  }
}
