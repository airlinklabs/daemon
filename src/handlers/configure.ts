import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

async function validatePanelUrl(url: string): Promise<boolean> {
    try {
        const response = await axios.get(`${url}/`);
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

async function updateEnvFile(panelUrl: string, key: string): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    let envContent: string;

    try {
        envContent = await fs.readFile(envPath, 'utf-8');
    } catch (error) {
        envContent = '';
    }

    const envConfig = dotenv.parse(envContent || '');

    const remoteIp = panelUrl
        .replace(/https?:\/\//, '')
        .split(':')[0];    

    envConfig.remote = remoteIp;
    envConfig.key = key;

    if (!envConfig.version) envConfig.version = '1.0.0';
    if (!envConfig.port) envConfig.port = '3502';

    const newEnvContent = Object.entries(envConfig)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    await fs.writeFile(envPath, newEnvContent, 'utf-8');
}


async function parseArguments(args: string[]): Promise<{ panelUrl: string; key: string }> {
    let panelUrl = '';
    let key = '';

    for (let i = 0; i < args.length; i++) {
        const currentArg = args[i];
        const nextArg = args[i + 1];

        if ((currentArg === '--panel' || currentArg === '-p') && nextArg && !nextArg.startsWith('-')) {
            panelUrl = nextArg;
        }
        if ((currentArg === '--key' || currentArg === '-k') && nextArg && !nextArg.startsWith('-')) {
            key = nextArg;
        }
    }

    return { panelUrl, key };
}

async function main() {
    const filteredArgs = process.argv.slice(2).filter(arg => arg !== '--');
    const { panelUrl: rawPanelUrl, key } = await parseArguments(filteredArgs);

    if (!rawPanelUrl || !key) {
        console.error('❌ Missing required parameters');
        console.log('Usage: npm run configure -- --panel <url> --key <key>');
        console.log('   or: npm run configure -- -p <url> -k <key>');
        process.exit(1);
    }

    const panelUrl = rawPanelUrl.replace(/\/$/, '');

    console.log('🔍 Validating panel URL...');
    const isValid = await validatePanelUrl(panelUrl);

    if (!isValid) {
        console.error('❌ Invalid panel URL or panel is not responding');
        process.exit(1);
    }

    console.log('✅ Panel URL is valid');
    console.log('📝 Updating configuration...');

    try {
        await updateEnvFile(panelUrl, key);
        console.log('✅ Configuration updated successfully');
        console.log('ℹ️ New configuration:');
        console.log(`Panel URL: ${panelUrl}`);
        console.log(`Daemon Key: ${key}`);
    } catch (error) {
        console.error('❌ Error updating configuration:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
});
