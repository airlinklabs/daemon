import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

async function validatePanelUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/`);
    return res.ok;
  } catch {
    return false;
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

async function updateEnvFile(panelUrl: string, key: string): Promise<void> {
  const envPath = path.join(process.cwd(), ".env");
  let envContent = "";
  try {
    envContent = await fs.readFile(envPath, "utf8");
  } catch {}
  const envConfig = parseEnvFile(envContent);
  envConfig.remote = panelUrl.replace(/https?:\/\//, "").split(":")[0] ?? "127.0.0.1";
  envConfig.key = key;
  if (!envConfig.version) envConfig.version = "3.0.0";
  if (!envConfig.port) envConfig.port = "3002";
  await fs.writeFile(envPath, Object.entries(envConfig).map(([name, value]) => `${name}=${value}`).join("\n"), "utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  let panelUrl = "";
  let key = "";
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === "--panel" || args[i] === "-p") && args[i + 1]) panelUrl = args[i + 1]!;
    if ((args[i] === "--key" || args[i] === "-k") && args[i + 1]) key = args[i + 1]!;
  }

  if (!panelUrl || !key) {
    console.error(chalk.red("[error] Missing required parameters"));
    console.log(chalk.yellow("Usage: bun run configure -- --panel <url> --key <key>"));
    process.exit(1);
  }

  panelUrl = panelUrl.replace(/\/$/, "");
  console.log(chalk.blue("[info] Validating panel URL..."));
  if (!(await validatePanelUrl(panelUrl))) {
    console.error(chalk.red("[error] Invalid panel URL or panel is not responding"));
    process.exit(1);
  }

  await updateEnvFile(panelUrl, key);
  console.log(chalk.green("[ok] Configuration updated successfully"));
  console.log(chalk.cyan(`Panel URL: ${panelUrl}`));
  console.log(chalk.cyan(`Daemon Key: ${key}`));
}

void main().catch((error) => {
  console.error(chalk.red("[error] Unexpected error"), error);
  process.exit(1);
});
