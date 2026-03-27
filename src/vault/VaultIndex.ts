import * as fs from 'fs';
import * as path from 'path';

export class VaultIndex {
  private noteNames: string[] = [];
  private vaultPath: string = '';

  async refresh(vaultPath: string): Promise<void> {
    this.vaultPath = vaultPath;
    this.noteNames = [];

    if (!vaultPath || !fs.existsSync(vaultPath)) return;

    try {
      this.noteNames = this.walkMd(vaultPath);
    } catch {
      // vault not accessible
    }
  }

  private walkMd(dir: string, depth = 0): string[] {
    if (depth > 6) return [];
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkMd(full, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Store note name without extension
        results.push(path.basename(entry.name, '.md'));
      }
    }
    return results;
  }

  /** Returns all note names (without .md extension) */
  getNoteNames(): string[] {
    return this.noteNames;
  }
}
