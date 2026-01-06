import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
import { loadConfig } from '../../utils/config-loader.js';

interface BuildOptions {
  platform: string; // Just for output directory naming (default: 'desktop')
  config: string;
}

export async function buildConsumerDesktop(options: BuildOptions) {
  try {
    console.log(`🔨 Building desktop consumer for ${options.platform}\n`);

    // Load configuration
    const config = await loadConfig(options.config);

    if (!config.consumers.desktop) {
      throw new Error('No desktop consumer configuration found');
    }

    const desktopConfig = config.consumers.desktop;

    // Resolve paths
    const configDir = path.resolve(options.config);
    const entryPath = path.resolve(configDir, desktopConfig.entry);
    const outputDir = path.resolve(configDir, 'build/consumers', options.platform);

    console.log(`📂 Entry point: ${desktopConfig.entry}`);
    console.log(`📦 Output directory: ${outputDir}\n`);

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Handle dependencies
    if (desktopConfig.dependencies) {
      await installDependencies(configDir, outputDir, desktopConfig.dependencies);
    }

    console.log('🔧 Bundling executor with esbuild...');
    await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outfile: path.join(outputDir, 'executor.js'),
      external: ['@qvac/*', 'expo-*', 'react-native*', '@tetherto/qvac-test-suite'],
      sourcemap: true,
    });

    const consumerEntryContent = `#!/usr/bin/env node
import('@tetherto/qvac-test-suite/dist/cli/consumer-entry.js');
`;
    fs.writeFileSync(path.join(outputDir, 'consumer.js'), consumerEntryContent);
    fs.chmodSync(path.join(outputDir, 'consumer.js'), 0o755);

    console.log(`\n✅ Consumer built successfully`);
    console.log(`\n📋 To run:`);
    console.log(
      `   node ${outputDir}/consumer.js --runId=<id> --executor=${outputDir}/executor.js --config=${configDir}`
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Build failed:', errorMessage);
    process.exit(1);
  }
}

/**
 * Install dependencies for the consumer
 */
async function installDependencies(
  configDir: string,
  outputDir: string,
  dependencies: 'auto' | Record<string, string>
): Promise<void> {
  console.log('📦 Installing dependencies...');

  if (dependencies === 'auto') {
    // Read from package.json in config directory
    const pkgJsonPath = path.join(configDir, 'package.json');

    if (!fs.existsSync(pkgJsonPath)) {
      console.log('⚠️  No package.json found, skipping dependency installation');
      return;
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8') as string);
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

    // Adjust relative file: paths to be correct from consumer directory
    const adjustedDeps = { ...deps };
    for (const [name, version] of Object.entries(adjustedDeps)) {
      if (typeof version === 'string' && (version.startsWith('file:') || version.startsWith('..'))) {
        const relativePath = version.replace('file:', '');
        const absolutePath = path.resolve(configDir, relativePath);
        const relativeFromConsumer = path.relative(outputDir, absolutePath);
        adjustedDeps[name] = `file:${relativeFromConsumer}`;
      }
    }

    const consumerPkgJson = {
      name: 'qvac-consumer',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        ...adjustedDeps,
        dotenv: '^16.4.5',
      },
    };

    fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify(consumerPkgJson, null, 2));
  } else {
    const consumerPkgJson = {
      name: 'qvac-consumer',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        ...dependencies,
        dotenv: '^16.4.5',
      },
    };

    fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify(consumerPkgJson, null, 2));
  }

  // Install dependencies
  console.log(`   Running npm install in ${outputDir}...`);
  execSync('npm install', {
    cwd: outputDir,
    stdio: 'inherit',
  });

  console.log('✅ Dependencies installed\n');
}
