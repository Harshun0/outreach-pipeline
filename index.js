#!/usr/bin/env node

require('dotenv').config();

const readline = require('readline');
const chalk = require('chalk');
const { findLookalikeCompanies, normalizeDomain } = require('./stages/apollo');
const { findDecisionMakers } = require('./stages/prospeo');
const { sendOutreachEmails } = require('./stages/brevo');

function printBanner() {
  console.log(chalk.bold.blue('\n========================================'));
  console.log(chalk.bold.blue('       OUTREACH PIPELINE CLI'));
  console.log(chalk.bold.blue('========================================\n'));
}

function validateEnv(stage = 'all') {
  const required = ['APOLLO_API_KEY', 'PROSPEO_API_KEY'];

  if (stage === 'all' || stage === 'brevo') {
    required.push('BREVO_API_KEY', 'SENDER_EMAIL', 'SENDER_NAME');
  }

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function printProspectTable(prospects) {
  const rows = prospects.map((prospect, index) => ({
    '#': index + 1,
    Name: prospect.name,
    Title: prospect.title,
    Company: prospect.company,
    Email: prospect.email,
  }));

  console.log('');
  console.table(rows);
  console.log('');
}

function parseArgs(argv) {
  const args = { domain: null, limit: null };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--limit' && argv[i + 1]) {
      args.limit = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    if (!arg.startsWith('--') && !args.domain) {
      args.domain = arg;
    }
  }

  if (!args.limit && process.env.MAX_EMAILS) {
    args.limit = Number(process.env.MAX_EMAILS);
  }

  return args;
}

function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function run() {
  printBanner();

  const { domain: seedDomain, limit: emailLimit } = parseArgs(process.argv);
  if (!seedDomain) {
    console.error(chalk.red('Usage: node index.js <domain> [--limit N]'));
    console.error(chalk.gray('Example: node index.js stripe.com --limit 1'));
    process.exit(1);
  }

  const normalizedSeed = normalizeDomain(seedDomain);
  validateEnv();

  try {
    console.log(chalk.bold(`Seed domain: ${normalizedSeed}`));
    if (emailLimit) {
      console.log(chalk.yellow(`Trial mode: sending to at most ${emailLimit} prospect(s)\n`));
    } else {
      console.log('');
    }

    console.log(chalk.bold.magenta('STAGE 1 — Apollo.io: Finding lookalike companies'));
    const companyDomains = await findLookalikeCompanies(normalizedSeed);
    console.log(chalk.green(`\nFound ${companyDomains.length} lookalike domain(s):`));
    companyDomains.forEach((domain, index) => {
      console.log(chalk.white(`  ${index + 1}. ${domain}`));
    });

    console.log(chalk.bold.magenta('\nSTAGE 2 — Prospeo: Finding decision makers'));
    const trialPriority = ['crossover.com', 'github.com', 'phonepe.com', 'netflix.com'];
    const searchDomains = emailLimit
      ? [...new Set([...trialPriority, ...companyDomains])].slice(0, 6)
      : companyDomains;
    const prospects = await findDecisionMakers(searchDomains, { maxProspects: emailLimit || undefined });

    if (prospects.length === 0) {
      console.log(chalk.yellow('\nNo prospects with verified emails found. Exiting.'));
      process.exit(0);
    }

    const toSend = emailLimit ? prospects.slice(0, emailLimit) : prospects;

    console.log(chalk.bold.magenta('\nSTAGE 3 — Safety checkpoint'));
    console.log(chalk.white(`Found ${toSend.length} prospect(s) ready for outreach:`));
    printProspectTable(toSend);

    const answer = await askConfirmation(
      chalk.bold.yellow(`Do you want to send emails to ${toSend.length} prospects? (yes/no): `)
    );

    if (answer !== 'yes') {
      console.log(chalk.yellow('\nEmail sending cancelled. No emails were sent.'));
      process.exit(0);
    }

    validateEnv('brevo');

    console.log(chalk.bold.magenta('\nSTAGE 4 — Brevo: Sending outreach emails'));
    const results = await sendOutreachEmails(toSend);

    console.log(chalk.bold.green('\nPipeline complete'));
    console.log(chalk.green(`  Sent: ${results.sent}`));
    if (results.failed > 0) {
      console.log(chalk.red(`  Failed: ${results.failed}`));
    }
  } catch (error) {
    console.error(chalk.red(`\nPipeline failed: ${error.message}`));
    process.exit(1);
  }
}

run();
