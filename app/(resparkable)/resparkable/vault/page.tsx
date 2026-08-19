/**
 * `/resparkable/vault`: markdown import and export (§14, Release 3).
 *
 * The only Resparkable page that fetches nothing. Both halves are user-initiated
 * file transfers, and a page that read the whole brain just to say "you have
 * 412 notes" would pay the cost of an export to render a number nobody acts on.
 *
 * The heading and the ⓘ come from `RESPARKABLE_SECTION_HELP` via the shell's
 * `<SectionHeader>`, like every other section.
 */

import type { Metadata } from 'next';
import { Info } from 'lucide-react';

import { VaultExportCard } from '@/components/resparkable/vault/vault-export-card';
import { VaultImportCard } from '@/components/resparkable/vault/vault-import-card';

export const metadata: Metadata = {
  title: 'Vault',
  description: 'Your brain as a folder of markdown, out and back in.',
};

export default function ResparkableVaultPage() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <VaultExportCard />
        <VaultImportCard />
      </div>

      {/* An aside, not a headline: the format is plain markdown and YAML
          frontmatter, full stop. Obsidian is one app that happens to read a
          folder like this out of the box, offered as an example rather than
          the thing this was built for. */}
      <div className="text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed p-4 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          This is plain markdown with YAML frontmatter, not a format built for one app. Obsidian is
          a well-known example that reads a folder like this as a working vault with no conversion
          step, but any editor or tool that works with markdown files on disk can open it.
        </p>
      </div>
    </div>
  );
}
