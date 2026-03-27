import type { VaultIndex } from './VaultIndex';

export class LinkMatcher {
  constructor(private vaultIndex: VaultIndex) {}

  /**
   * Given an array of key topics from the summarizer, match them against
   * existing vault notes and return [[wikilink]] strings.
   */
  match(keyTopics: string[]): string[] {
    const noteNames = this.vaultIndex.getNoteNames();
    const noteNamesLower = noteNames.map(n => n.toLowerCase());

    const matched = new Set<string>();

    for (const topic of keyTopics) {
      const topicLower = topic.toLowerCase();

      // Exact match first
      const exactIdx = noteNamesLower.indexOf(topicLower);
      if (exactIdx !== -1) {
        matched.add(noteNames[exactIdx]);
        continue;
      }

      // Partial match: note name contains topic word or vice versa
      for (let i = 0; i < noteNamesLower.length; i++) {
        if (
          noteNamesLower[i].includes(topicLower) ||
          topicLower.includes(noteNamesLower[i])
        ) {
          matched.add(noteNames[i]);
          break;
        }
      }
    }

    return Array.from(matched);
  }
}
