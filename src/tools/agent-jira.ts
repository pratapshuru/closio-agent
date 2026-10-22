// Read-only Jira lookup for agents: agent-jira <KEY> [--save <dir>]
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { issueWithLatestComments, relatedText } from '../sprint.ts';
import { Jira } from '../jira.ts';
import { writeText } from '../util.ts';

const [key, flag, dir] = process.argv.slice(2);
if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
  console.error('usage: agent-jira <TICKET-KEY> [--save <dir>]');
  process.exit(2);
}
const config = loadConfig();
const issue = await issueWithLatestComments(new Jira(config), key);
// includes that ticket's handoff note, if its run left one
const text = relatedText(config, issue);
if (flag === '--save' && dir) writeText(path.join(dir, `${key}.md`), text);
console.log(text);
