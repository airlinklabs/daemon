export {};

const firstArg = process.argv[2];
const args = process.argv.slice(2);

function printHelp(): void {
  const bin = process.argv[1]?.split('/').pop() || 'airlinkd';
  console.log(`Airlink daemon

Usage:
  ${bin} [start]
  ${bin} configure --panel <url> --key <key>
  ${bin} --help

Commands:
  start       Run the daemon. This is the default when no command is given.
  configure  Write .env values for the panel host and daemon key.

Options:
  -h, --help  Show this help.

Examples:
  ${bin}
  ${bin} start
  ${bin} configure --panel http://panel.example.com:3000 --key your-node-key
  ${bin} configure -p http://localhost:3000 -k your-node-key`);
}

if (args.includes('--help') || args.includes('-h')) {
  if (firstArg === 'configure') {
    const { printConfigureHelp } = await import('./configure');
    printConfigureHelp();
  } else {
    printHelp();
  }
  process.exit(0);
}

if (firstArg === 'configure') {
  const { runConfigure } = await import('./configure');
  await runConfigure(process.argv.slice(3));
  process.exit(0);
}

if (firstArg && firstArg !== 'start') {
  console.error(`Unknown command: ${firstArg}`);
  console.log('Run with --help to see the available commands.');
  process.exit(1);
}

await import('./protobufLong');
await import('./bootstrap');
await import('./server');
