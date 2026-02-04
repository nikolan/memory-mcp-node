#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface InitConfig {
  memoryDir: string;
  openaiApiKey?: string;
  voyageApiKey?: string;
  llmProvider?: 'openai';
  embeddingProvider: 'voyage' | 'local';
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const suffix = defaultValue ? ` (default: ${defaultValue})` : '';
  const answer = await rl.question(`${question}${suffix}: `);
  rl.close();
  return answer.trim() || defaultValue || '';
}

function ensureDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✓ Created directory: ${dir}`);
  } else {
    console.log(`✓ Directory exists: ${dir}`);
  }
}

async function setupMemoryDir(): Promise<string> {
  console.log('\n📁 Memory Storage Location\n');
  
  const defaultDir = path.join(PROJECT_ROOT, '.memory');
  const homeDir = path.join(homedir(), '.memory-mcp');
  
  console.log('Where should memory be stored?');
  console.log(`  1. Project-local (${defaultDir})`);
  console.log(`  2. User home directory (${homeDir})`);
  console.log('  3. Custom path');
  
  const choice = await prompt('\nChoice', '1');
  
  let memoryDir: string;
  
  if (choice === '2') {
    memoryDir = homeDir;
  } else if (choice === '3') {
    memoryDir = await prompt('Enter custom path');
    if (!memoryDir) {
      console.log('❌ No path provided, using default');
      memoryDir = defaultDir;
    }
  } else {
    memoryDir = defaultDir;
  }
  
  if (memoryDir.startsWith('~/')) {
    memoryDir = path.join(homedir(), memoryDir.slice(2));
  }
  
  memoryDir = path.resolve(memoryDir);
  
  const parentDir = path.dirname(memoryDir);
  if (!fs.existsSync(parentDir)) {
    console.log(`❌ Parent directory doesn't exist: ${parentDir}`);
    throw new Error('Cannot create memory directory');
  }
  
  ensureDirectory(memoryDir);
  ensureDirectory(path.join(memoryDir, 'memory'));
  ensureDirectory(path.join(memoryDir, 'team'));
  
  const memoryFile = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, `# Memory

This file stores important information about you, your preferences, decisions, and contacts.

## User Preferences

Add information about your preferences here.

## Important Decisions

Record significant decisions you've made.

## Key Contacts

Important people and their contact information.
`, 'utf-8');
    console.log('✓ Created MEMORY.md template');
  }
  
  return memoryDir;
}

async function setupEnvFile(memoryDir: string): Promise<InitConfig> {
  console.log('\n🔑 API Keys Configuration\n');
  
  const configDir = path.join(homedir(), '.memory-mcp');
  const envPath = path.join(configDir, '.env');
  let existingEnv: Record<string, string> = {};
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (fs.existsSync(envPath)) {
    console.log(`✓ Found existing ${envPath}`);
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        existingEnv[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  
  console.log('Choose your provider setup:\n');
  console.log('  1. Fully local (no API keys) ← Zero cost, search/store only');
  console.log('  2. OpenAI (local embeddings + LLM for maintenance)');
  console.log('  3. OpenAI + Voyage (Voyage embeddings + OpenAI LLM)');
  console.log('  4. Custom (mix providers)\n');

  const setupChoice = await prompt('Choice', '1');

  let openaiApiKey = existingEnv.OPENAI_API_KEY;
  let voyageApiKey = existingEnv.VOYAGE_API_KEY;
  let llmProvider: 'openai' | undefined = undefined;
  let embeddingProvider: 'voyage' | 'local' = 'local';
  
  if (setupChoice === '1') {
    embeddingProvider = 'local';
    llmProvider = undefined;
    
    console.log('\n✓ Fully local setup - no API keys required');
    console.log('  - Search and store work offline');
    console.log('  - Maintenance (compact/promote) disabled without LLM');
    console.log('  - First run downloads embedding model (~23MB)\n');
    
  } else if (setupChoice === '2') {
    embeddingProvider = 'local';
    llmProvider = 'openai';

    if (!openaiApiKey) {
      console.log('\nOpenAI API key enables maintenance features (compact/promote).');
      openaiApiKey = await prompt('Enter OpenAI API key (sk-...)');
      if (!openaiApiKey) {
        throw new Error('OpenAI API key is required for this setup');
      }
    } else {
      console.log('✓ Using existing OpenAI API key');
    }

    console.log('\n✓ Using local embeddings (transformers.js)');
    console.log('  First run will download model (~23MB), then cached locally.\n');
    
  } else if (setupChoice === '3') {
    embeddingProvider = 'voyage';
    llmProvider = 'openai';

    if (!openaiApiKey) {
      console.log('\nOpenAI API key is required for LLM calls.');
      openaiApiKey = await prompt('Enter OpenAI API key (sk-...)');
      if (!openaiApiKey) {
        throw new Error('OpenAI API key is required for this setup');
      }
    } else {
      console.log('✓ Using existing OpenAI API key');
    }

    if (!voyageApiKey) {
      console.log('\nVoyage API key is required for embeddings (200M free tokens at voyageai.com).');
      voyageApiKey = await prompt('Enter Voyage API key (pa-...)');
      if (!voyageApiKey) {
        throw new Error('Voyage API key is required for this setup');
      }
    } else {
      console.log('✓ Using existing Voyage API key');
    }
    
  } else if (setupChoice === '4') {
    console.log('\nConfigure each provider:\n');

    const wantsOpenai = await prompt('Add OpenAI API key? (y/n)', openaiApiKey ? 'y' : 'n');
    if (wantsOpenai.toLowerCase() === 'y' && !openaiApiKey) {
      openaiApiKey = await prompt('Enter OpenAI API key (sk-...)');
    }

    const wantsVoyage = await prompt('Add Voyage API key? (y/n)', voyageApiKey ? 'y' : 'n');
    if (wantsVoyage.toLowerCase() === 'y' && !voyageApiKey) {
      voyageApiKey = await prompt('Enter Voyage API key (pa-...)');
    }

    const embOptions = ['local'];
    if (voyageApiKey) embOptions.push('voyage');
    const embChoice = await prompt(`Embedding provider? (${embOptions.join('/')})`, 'local');
    if (embChoice.toLowerCase() === 'voyage' && voyageApiKey) {
      embeddingProvider = 'voyage';
    } else {
      embeddingProvider = 'local';
    }

    if (openaiApiKey) {
      const llmChoice = await prompt('Enable LLM for maintenance? (y/n)', 'y');
      if (llmChoice.toLowerCase() === 'y') {
        llmProvider = 'openai';
      }
    } else {
      console.log('✓ No LLM configured (maintenance features disabled)');
    }
    
  } else {
    embeddingProvider = 'local';
    llmProvider = undefined;
    
    console.log('\n✓ Defaulting to fully local setup - no API keys required');
    console.log('  - Search and store work offline');
    console.log('  - Maintenance features disabled without LLM\n');
  }
  
  const envContent = ['# API keys only'];

  if (openaiApiKey) {
    envContent.push('');
    envContent.push(`OPENAI_API_KEY="${openaiApiKey}"`);
  }

  if (voyageApiKey) {
    envContent.push('');
    envContent.push(`VOYAGE_API_KEY="${voyageApiKey}"`);
  }

  envContent.push('');

  fs.writeFileSync(envPath, envContent.join('\n'), 'utf-8');
  console.log(`\n✓ Saved API keys to ${envPath}`);

  return {
    memoryDir,
    openaiApiKey,
    voyageApiKey,
    llmProvider,
    embeddingProvider,
  };
}

async function testMcpServer(): Promise<boolean> {
  console.log('\n🧪 Testing MCP Server\n');
  
  try {
    console.log('Building project...');
    const { execSync } = await import('child_process');
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    console.log('✓ Build successful');
    
    const distPath = path.join(PROJECT_ROOT, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      console.log('❌ Built files not found');
      return false;
    }
    console.log('✓ Built files exist');
    
    return true;
  } catch (error) {
    console.log('❌ Build failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

function generateMcpConfig(_config: InitConfig): void {
  console.log('\n📋 MCP Configuration\n');
  
  const mcpConfig = {
    mcpServers: {
      'memory': {
        command: 'npx',
        args: ['local-memory-mcp'],
      },
    },
  };
  
  console.log('Add this to your MCP client configuration:');
  console.log('\n' + '='.repeat(60));
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log('='.repeat(60) + '\n');
  
  console.log(`API keys are loaded from ~/.memory-mcp/.env`);
  console.log('No secrets or paths in the MCP config.\n');
  
  const configFile = path.join(PROJECT_ROOT, 'mcp-config.json');
  fs.writeFileSync(configFile, JSON.stringify(mcpConfig, null, 2), 'utf-8');
  console.log(`✓ Reference config saved to: ${configFile}\n`);
}

async function main(): Promise<void> {
  console.log('\n🚀 Memory MCP Initialization\n');
  console.log('This will set up your local memory system.\n');
  
  try {
    const memoryDir = await setupMemoryDir();
    const config = await setupEnvFile(memoryDir);
    const testPassed = await testMcpServer();
    
    if (!testPassed) {
      console.log('\n⚠️  Setup complete but tests failed. Check the errors above.\n');
      process.exit(1);
    }
    
    generateMcpConfig(config);
    
    console.log('✅ Initialization complete!\n');
    console.log('Next steps:');
    console.log('  1. Copy the MCP configuration above to your client');
    console.log('  2. Restart your MCP client (Claude Desktop, Cursor, etc.)');
    console.log('  3. Start using memory tools in your conversations\n');
    
  } catch (error) {
    console.error('\n❌ Initialization failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main as initSetup };
