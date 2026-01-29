import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export type EnvironmentType = 'venv' | 'conda' | 'system' | 'pyenv' | 'pipenv';

export interface PythonEnvironment {
  path: string;
  name: string;
  version: string;
  type: EnvironmentType;
  hasIpykernel: boolean;
}

async function execPython(pythonPath: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, ['-c', code], {
      timeout: 10000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

async function getPythonVersion(pythonPath: string): Promise<string | null> {
  try {
    const version = await execPython(
      pythonPath,
      'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'
    );
    return version;
  } catch {
    return null;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findPythonInDir(dir: string): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? ['python.exe', 'Scripts/python.exe']
    : ['bin/python3', 'bin/python'];

  for (const candidate of candidates) {
    const fullPath = path.join(dir, candidate);
    if (await fileExists(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

export class PythonSetup {
  private workspaceDir: string;

  constructor(workspaceDir: string = process.cwd()) {
    this.workspaceDir = workspaceDir;
  }

  async checkIpykernel(pythonPath: string): Promise<boolean> {
    try {
      await execPython(pythonPath, 'import ipykernel');
      return true;
    } catch {
      return false;
    }
  }

  async installIpykernel(pythonPath: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const proc = spawn(pythonPath, ['-m', 'pip', 'install', '--quiet', 'ipykernel'], {
        timeout: 120000,
      });
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || `pip install failed with code ${code}` });
        }
      });
      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }

  async discoverEnvironments(): Promise<PythonEnvironment[]> {
    const environments: PythonEnvironment[] = [];
    const seen = new Set<string>();

    const addEnv = async (
      pythonPath: string,
      name: string,
      type: EnvironmentType
    ): Promise<void> => {
      const realPath = await fs.realpath(pythonPath).catch(() => pythonPath);
      if (seen.has(realPath)) return;
      seen.add(realPath);

      const version = await getPythonVersion(pythonPath);
      if (!version) return;

      const hasIpykernel = await this.checkIpykernel(pythonPath);
      environments.push({ path: pythonPath, name, version, type, hasIpykernel });
    };

    // 1. Local virtual environments (./venv, ./.venv)
    for (const venvName of ['venv', '.venv']) {
      const venvDir = path.join(this.workspaceDir, venvName);
      if (await directoryExists(venvDir)) {
        const pythonPath = await findPythonInDir(venvDir);
        if (pythonPath) {
          await addEnv(pythonPath, venvName, 'venv');
        }
      }
    }

    // 2. pyenv environments
    const pyenvRoot = process.env.PYENV_ROOT || path.join(os.homedir(), '.pyenv');
    const pyenvVersionsDir = path.join(pyenvRoot, 'versions');
    if (await directoryExists(pyenvVersionsDir)) {
      try {
        const versions = await fs.readdir(pyenvVersionsDir);
        for (const version of versions) {
          const versionDir = path.join(pyenvVersionsDir, version);
          const pythonPath = await findPythonInDir(versionDir);
          if (pythonPath) {
            await addEnv(pythonPath, `pyenv: ${version}`, 'pyenv');
          }
        }
      } catch { /* ignore */ }
    }

    // 3. Conda environments
    const condaDirs = [
      path.join(os.homedir(), 'anaconda3', 'envs'),
      path.join(os.homedir(), 'miniconda3', 'envs'),
      path.join(os.homedir(), 'miniforge3', 'envs'),
      path.join(os.homedir(), 'mambaforge', 'envs'),
    ];
    if (process.env.CONDA_PREFIX) {
      condaDirs.unshift(path.join(process.env.CONDA_PREFIX, '..'));
    }

    for (const condaEnvsDir of condaDirs) {
      if (await directoryExists(condaEnvsDir)) {
        try {
          const envs = await fs.readdir(condaEnvsDir);
          for (const envName of envs) {
            const envDir = path.join(condaEnvsDir, envName);
            const pythonPath = await findPythonInDir(envDir);
            if (pythonPath) {
              await addEnv(pythonPath, `conda: ${envName}`, 'conda');
            }
          }
        } catch { /* ignore */ }
      }
    }

    // Also check conda base environments
    const condaBaseDirs = [
      path.join(os.homedir(), 'anaconda3'),
      path.join(os.homedir(), 'miniconda3'),
      path.join(os.homedir(), 'miniforge3'),
      path.join(os.homedir(), 'mambaforge'),
    ];
    for (const baseDir of condaBaseDirs) {
      const pythonPath = await findPythonInDir(baseDir);
      if (pythonPath) {
        const baseName = path.basename(baseDir);
        await addEnv(pythonPath, `conda: ${baseName} (base)`, 'conda');
      }
    }

    // 4. pipenv environments
    const pipenvDir = path.join(os.homedir(), '.local', 'share', 'virtualenvs');
    if (await directoryExists(pipenvDir)) {
      try {
        const envs = await fs.readdir(pipenvDir);
        for (const envName of envs) {
          const envDir = path.join(pipenvDir, envName);
          const pythonPath = await findPythonInDir(envDir);
          if (pythonPath) {
            await addEnv(pythonPath, `pipenv: ${envName}`, 'pipenv');
          }
        }
      } catch { /* ignore */ }
    }

    // 5. System Python
    const systemPythons = process.platform === 'win32'
      ? ['python', 'python3']
      : ['python3', '/usr/bin/python3', '/usr/local/bin/python3'];

    for (const pythonCmd of systemPythons) {
      try {
        // Use 'which' or 'where' to find the actual path
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawn(whichCmd, [pythonCmd], { timeout: 5000 });
          let stdout = '';
          proc.stdout.on('data', (data) => { stdout += data.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve(stdout.trim().split('\n')[0]);
            else reject(new Error('not found'));
          });
          proc.on('error', reject);
        });
        if (result) {
          await addEnv(result, 'System Python', 'system');
          break; // Only add one system Python
        }
      } catch { /* ignore */ }
    }

    return environments;
  }
}
