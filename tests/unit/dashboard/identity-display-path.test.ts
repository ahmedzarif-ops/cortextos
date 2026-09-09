import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Port of the PR33 identity fixture: exercise real source and filesystem reads.
// Only configuration, unrelated data services and card chrome are substitutes.
// React server rendering proves card text output, not browser interaction.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dashboardRequire = createRequire(resolve(repoRoot, 'dashboard/package.json'));
const ts = dashboardRequire('typescript');
const React = dashboardRequire('react');
const { renderToStaticMarkup } = dashboardRequire('react-dom/server');
const readSource = (relative: string) => readFileSync(resolve(repoRoot, 'dashboard/src', relative), 'utf8');
const agentsSource = readSource('lib/data/agents.ts');
const parserSource = readSource('lib/markdown-parser.ts');

function load(source: string, mocks: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  runInNewContext(js, {
    exports, require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : dashboardRequire(name),
    console, process, Buffer,
  });
  return exports;
}

// Same raw bytes as the original review fixture, including editor hints.
const RAW = '# Identity\n\n## Name\n<!-- Agent name -->\n\n## Role\n<!-- role -->\n\n## Emoji\n<!-- emoji -->\n\n## Vibe\nTBD\n\n## Work Style\nCareful <!-- internal --> reviewer\n';
let fixture: string;
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'identity-display-path-'));
  writeFileSync(join(fixture, 'IDENTITY.md'), RAW);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function identityReader(source = agentsSource, parser = load(parserSource)) {
  return load(source, {
    '@/lib/config': {
      CTX_ROOT: fixture, getAgentDir: () => fixture,
      getHeartbeatPath: () => join(fixture, 'heartbeat.json'),
      getAgentStateDir: () => fixture,
    },
    '@/lib/data/heartbeats': {}, '@/lib/data/tasks': {},
    '@/lib/markdown-parser': parser, '@/lib/utils': load(readSource('lib/utils.ts')),
  }).getAgentIdentity;
}

// Render the actual AgentCard: its name/role conditionals and text expressions
// stay real. Stub unrelated controls to avoid router contexts and client effects.
const box = ({ children }: any) => React.createElement('div', null, children);
const empty = () => null;
const AgentCard = load(readSource('components/agents/agent-card.tsx'), {
  'next/link': ({ children, href }: any) => React.createElement('a', { href }, children),
  'next/navigation': { useRouter: () => ({ refresh() {} }) },
  '@/components/ui/card': { Card: box, CardContent: box },
  '@/components/shared/health-dot': { HealthDot: empty },
  '@/components/shared/org-badge': { OrgBadge: empty },
  '@/components/shared/runtime-badge': { RuntimeBadge: empty },
  '@/components/shared/agent-avatar': { AgentAvatar: ({ emoji }: any) => React.createElement('span', null, emoji) },
  './agent-actions': { AgentActions: empty },
  '@tabler/icons-react': { IconChecklist: empty },
}).AgentCard;

function render(identity: any) {
  return renderToStaticMarkup(React.createElement(AgentCard, { agent: {
    name: identity.name, role: identity.role, emoji: identity.emoji,
    systemName: 'fixture-agent', org: '', health: 'healthy', tasksToday: 0,
  } }));
}
const hasMarker = (html: string) => /<!--|&lt;!--/.test(html);

function displayViolations(identity: any) {
  const expected: Record<string, string> = {
    name: 'fixture-agent', role: '', emoji: '', vibe: '', workStyle: 'Careful  reviewer',
  };
  return Object.keys(expected).filter(key => identity[key] !== expected[key]);
}
function editorViolations(identity: any, parsed: any) {
  return [
    ...(identity.raw !== RAW ? ['raw'] : []),
    ...(!parsed.fields.name.includes('<!-- Agent name -->') ? ['name-hint'] : []),
    ...(!parsed.fields.role.includes('<!-- role -->') ? ['role-hint'] : []),
  ];
}

describe('identity display/editor split', () => {
  it('reads a real IDENTITY.md through the real parser and sanitizes all five display fields', async () => {
    expect(displayViolations(await identityReader()('fixture-agent'))).toEqual([]);
  });

  it('keeps the raw file and parser hints for the editor', async () => {
    const identity = await identityReader()('fixture-agent');
    expect(editorViolations(identity, load(parserSource).parseIdentityMd(RAW))).toEqual([]);
    expect(readFileSync(join(fixture, 'IDENTITY.md'), 'utf8')).toBe(RAW);
  });

  it('renders the real card without literal OR escaped comment markers', async () => {
    const html = render(await identityReader()('fixture-agent'));
    expect(hasMarker(html)).toBe(false);
    expect(html).not.toContain('Agent name');
    expect(html).not.toContain('&lt;!-- role');
    expect(html).toContain('fixture-agent');
    expect(html).toContain('/agents/fixture-agent');
  });

  it('keeps meaningful name, role and emoji visible in the rendered card', async () => {
    writeFileSync(join(fixture, 'IDENTITY.md'), '# Identity\n\n## Name\nMira\n\n## Role\nCareful <!-- private hint --> reviewer\n\n## Emoji\n🛡️\n');
    const html = render(await identityReader()('fixture-agent'));
    expect(html).toContain('Mira');
    expect(html).toContain('Careful  reviewer');
    expect(html).toContain('🛡️');
    expect(html).not.toContain('private hint');
    expect(hasMarker(html)).toBe(false);
  });

  it('detects removing sanitation at the data boundary, including escaped render leakage', async () => {
    const mutated = agentsSource.replace(/displayField\(fields\.(name|role|emoji|vibe|workStyle), (?:name|'')\)/g, 'fields.$1');
    expect(mutated).not.toBe(agentsSource);
    const identity = await identityReader(mutated)('fixture-agent');
    expect(displayViolations(identity)).toEqual(['name', 'role', 'emoji', 'vibe', 'workStyle']);
    expect(hasMarker(render(identity))).toBe(true);
    // The editor remains intact: this mutant damages only the display side.
    expect(editorViolations(identity, load(parserSource).parseIdentityMd(RAW))).toEqual([]);
  });

  it('detects moving sanitation into the parser, which erases editor hints', async () => {
    const parser = load(parserSource);
    const realParse = parser.parseIdentityMd;
    parser.parseIdentityMd = (raw: string) => realParse(raw.replace(/<!--[\s\S]*?-->/g, ''));
    const identity = await identityReader(agentsSource, parser)('fixture-agent');
    expect(displayViolations(identity)).toEqual([]);
    expect(hasMarker(render(identity))).toBe(false);
    expect(editorViolations(identity, parser.parseIdentityMd(RAW))).toEqual(['name-hint', 'role-hint']);
  });
});
