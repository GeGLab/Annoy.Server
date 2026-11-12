import {execFileSync} from 'node:child_process';
import {githubApi,requireMergedMain} from './lib/github-api.mjs';
await requireMergedMain(githubApi(),execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
