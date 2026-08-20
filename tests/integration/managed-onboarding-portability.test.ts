import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const WINDOWS_REFERENCE = 'templates/references/managed-onboarding-windows.md';

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8');
}

function roleOnboardingFiles(parent: 'templates' | 'community/agents'): string[] {
  const root = join(ROOT, parent);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'ONBOARDING.md'))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'));
}

const ROLE_DOCUMENTS = [
  ...roleOnboardingFiles('templates'),
  ...roleOnboardingFiles('community/agents'),
].sort();

const ONBOARDING_SKILLS = [
  'community/skills/onboarding/SKILL.md',
  'templates/agent/.claude/skills/onboarding/SKILL.md',
  'templates/agent-codex/plugins/cortextos-agent-skills/skills/onboarding/SKILL.md',
  'templates/agent-opencode/plugins/cortextos-agent-skills/skills/onboarding/SKILL.md',
  'templates/analyst/.claude/skills/onboarding/SKILL.md',
  'templates/orchestrator/.claude/skills/onboarding/SKILL.md',
  'community/agents/research-agent/.claude/skills/onboarding/SKILL.md',
  'community/agents/security/.claude/skills/onboarding/SKILL.md',
];

describe('managed-agent onboarding portability contract', () => {
  it('covers every shipped managed role with exactly one Telegram question requiring one answer per turn', () => {
    expect(ROLE_DOCUMENTS).toEqual([
      'community/agents/agent/ONBOARDING.md',
      'community/agents/agentic-crm-assistant/ONBOARDING.md',
      'community/agents/analyst/ONBOARDING.md',
      'community/agents/orchestrator/ONBOARDING.md',
      'community/agents/research-agent/ONBOARDING.md',
      'community/agents/security/ONBOARDING.md',
      'templates/agent-codex/ONBOARDING.md',
      'templates/agent-opencode/ONBOARDING.md',
      'templates/agent/ONBOARDING.md',
      'templates/analyst/ONBOARDING.md',
      'templates/orchestrator/ONBOARDING.md',
    ]);

    for (const path of ROLE_DOCUMENTS) {
      const content = read(path);
      expect(content, path).toContain('**ONE-QUESTION TURN GATE:**');
      expect(content, path).toMatch(/exactly one onboarding question that requires\s+exactly one answer/);
      expect(content, path).toContain('exactly one outbound Telegram message');
      expect(content, path).toMatch(/Never combine\s+multiple questions, multi-part questions, or independent requested answers/);
      expect(content, path).toMatch(/split\s+(?:any|every)\s+independently answerable (?:subquestions or bullets|setup item)/i);
      expect(content, path).toContain('**END YOUR TURN**');
      expect(content, path).toContain('earliest unanswered item');
      expect(content, path).toMatch(/without\s+repeating\s+completed questions/);
      expect(content, path).toContain('templates/references/managed-onboarding-windows.md');

      expect(content, path).not.toContain('ONE-TOPIC');
      expect(content, path).not.toContain('topical onboarding');

      const gate = content.indexOf('**ONE-QUESTION TURN GATE:**');
      const firstQuestion = content.indexOf('?');
      if (firstQuestion === -1) {
        expect(path).toBe('community/agents/agentic-crm-assistant/ONBOARDING.md');
        expect(content).toContain('.claude/skills/agentic-crm-setup/SKILL.md');
      } else {
        expect(gate, `${path} must establish the turn boundary before its first question`).toBeLessThan(firstQuestion);
      }
    }
  });

  it('keeps every shipped onboarding skill copy on the same turn and resume protocol', () => {
    for (const path of ONBOARDING_SKILLS) {
      const content = read(path);
      expect(content, path).toContain('## Conversation turn gate');
      expect(content, path).toContain('exactly one question per agent turn');
      expect(content, path).toMatch(/one onboarding question\s+requiring exactly one answer/);
      expect(content, path).toContain('exactly one outbound Telegram message');
      expect(content, path).toMatch(/Never\s+combine multiple questions, multi-part questions, or independent requested\s+answers/);
      expect(content, path).toMatch(/Split every independently answerable numbered item,\s+subquestion, or bullet into its own turn/);
      expect(content, path).toContain('**END YOUR TURN**');
      expect(content, path).toContain('earliest unanswered item');
      expect(content, path).toContain(WINDOWS_REFERENCE);
      expect(content, path).toContain('crons.json');
      expect(content, path).toContain('cortextos bus add-cron');
      expect(content, path).not.toContain('| Crons configured and running | `config.json` |');
      expect(content, path).not.toContain('topical onboarding');
    }
  });

  it('makes the CRM setup sequence obey the shared managed turn gate', () => {
    const path = 'community/agents/agentic-crm-assistant/.claude/skills/agentic-crm-setup/SKILL.md';
    const content = read(path);
    expect(content).toMatch(/exactly one onboarding question requiring exactly one answer\s+in exactly one outbound message/);
    expect(content).toMatch(/Never combine multiple questions, multi-part\s+questions, or independent requested answers/);
    expect(content).toMatch(/Split every independently\s+answerable numbered item, subquestion, or bullet into its own turn/);
    expect(content).toContain('**END YOUR TURN**');
    expect(content).toContain('earliest unanswered item');
    expect(content).toContain(WINDOWS_REFERENCE);
    expect(content).toContain('cortextos bus add-cron');
    expect(content).toContain('crons.json');
    expect(content).not.toContain('Question Batches');
    expect(content).not.toContain('Ask questions in small batches');
    expect(content).not.toContain('topical onboarding');
  });

  it('keeps Windows mechanics in one operations-only reference', () => {
    const content = read(WINDOWS_REFERENCE);
    for (const required of [
      'node -p "process.platform"',
      '`win32`',
      'Join-Path',
      'New-Item -ItemType File',
      "'.onboarded'",
      'cortextos bus read-all-heartbeats',
      'cortextos bus add-cron',
      'cortextos bus send-telegram',
      'crons.json',
      '**END YOUR TURN**',
    ]) {
      expect(content, required).toContain(required);
    }
    expect(content).not.toContain('## Part 1');
    expect(content).not.toMatch(/What (?:should|are|do|kind|is)\b/);
    expect(content).toMatch(/exactly one onboarding question that\s+requires exactly one answer/);
    expect(content).toMatch(/Never combine multiple questions, multi-part questions, or\s+independent requested answers/);
    expect(content).not.toContain('topical question');
  });
});
