const axios = require('axios');
const chalk = require('chalk');
const { normalizeDomain } = require('./apollo');

const PROSPEO_BASE_URL = 'https://api.prospeo.io';
const CONTACTS_PER_DOMAIN = 3;
const DOMAIN_DELAY_MS = Number(process.env.PROSPEO_DOMAIN_DELAY_MS) || 2000;
const REQUEST_GAP_MS = Number(process.env.PROSPEO_REQUEST_GAP_MS) || 1200;

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_GAP_MS) {
    await sleep(REQUEST_GAP_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

function getPersonName(person) {
  if (person.full_name) return person.full_name;
  const parts = [person.first_name, person.last_name].filter(Boolean);
  return parts.join(' ') || 'Unknown';
}

function extractEmail(person) {
  if (!person?.email) return null;
  if (typeof person.email === 'string') return person.email;
  return person.email.email || person.email.value || person.email.address || null;
}

function getRateLimitWait(headers) {
  const minuteLeft = Number(headers['x-minute-request-left']);
  const minuteReset = Number(headers['x-second-rate-limit']) || Number(headers['x-minute-reset-seconds']);

  if (minuteLeft === 0 && minuteReset > 0) {
    return minuteReset * 1000;
  }

  return REQUEST_GAP_MS;
}

async function prospeoPost(client, endpoint, payload) {
  await throttle();

  try {
    const response = await client.post(`${PROSPEO_BASE_URL}${endpoint}`, payload);
    const data = response.data;

    if (data.error || data.req_status === false) {
      const code = data.error_code || 'UNKNOWN_ERROR';
      const detail = data.error_toast || data.filter_error || data.message || code;

      if (code === 'NO_RESULTS') return null;
      if (code === 'NO_MATCH') return { matched: [], not_matched: [] };
      if (code === 'INVALID_API_KEY') throw new Error('Prospeo authentication failed. Check PROSPEO_API_KEY.');
      if (code === 'INSUFFICIENT_CREDITS') throw new Error('Prospeo insufficient credits. Top up your account and retry.');
      if (code === 'RATE_LIMITED') throw new Error('Prospeo rate limit exceeded.');

      throw new Error(`Prospeo API error (${code}): ${detail}`);
    }

    return data;
  } catch (error) {
    if (error.message.startsWith('Prospeo')) throw error;

    const status = error.response?.status;
    const body = error.response?.data || {};
    const code = body.error_code;
    const detail = body.error_toast || body.filter_error || body.message || error.message;
    const headers = error.response?.headers || {};

    if (code === 'NO_RESULTS') return null;
    if (code === 'NO_MATCH') return { matched: [], not_matched: [] };

    if (status === 429 || code === 'RATE_LIMITED') {
      const wait = getRateLimitWait(headers);
      if (wait > REQUEST_GAP_MS) {
        console.log(chalk.yellow(`  Rate limited — waiting ${Math.ceil(wait / 1000)}s...`));
        await sleep(wait);
        return prospeoPost(client, endpoint, payload);
      }
      throw new Error('Prospeo rate limit exceeded. Wait a minute and retry.');
    }

    if (status === 401 || code === 'INVALID_API_KEY') {
      throw new Error('Prospeo authentication failed. Check PROSPEO_API_KEY.');
    }

    throw new Error(`Prospeo API error${status ? ` (${status})` : ''}: ${detail}`);
  }
}

async function searchPeople(client, domain, limit = CONTACTS_PER_DOMAIN) {
  return prospeoPost(client, '/search-person', {
    page: 1,
    filters: {
      company: { websites: { include: [domain] } },
      person_seniority: { include: ['C-Suite', 'Vice President'] },
      max_person_per_company: limit,
    },
  });
}

async function enrichPerson(client, personId) {
  return prospeoPost(client, '/enrich-person', {
    only_verified_email: true,
    enrich_mobile: false,
    data: { person_id: personId },
  });
}

async function findProspectsForDomain(client, domain, { maxContacts = CONTACTS_PER_DOMAIN } = {}) {
  const normalizedDomain = normalizeDomain(domain);
  console.log(chalk.cyan(`  Domain search: ${normalizedDomain}`));

  const searchData = await searchPeople(client, normalizedDomain, maxContacts);
  if (!searchData) {
    console.log(chalk.yellow(`  No C-suite/VP contacts found for ${normalizedDomain}`));
    return [];
  }

  const results = (searchData.results || []).slice(0, maxContacts);
  const prospects = [];

  for (const result of results) {
    const person = result.person || {};
    const company = result.company || {};
    const personId = person.person_id || person.id;

    if (!personId) continue;

    const enrichData = await enrichPerson(client, personId);
    if (!enrichData?.person) continue;

    const email = extractEmail(enrichData.person);
    if (!email) continue;

    prospects.push({
      name: getPersonName(enrichData.person),
      title: enrichData.person.current_job_title || person.current_job_title || 'Unknown',
      company: company.name || normalizedDomain,
      domain: normalizedDomain,
      email,
    });

    if (prospects.length >= maxContacts) break;
  }

  if (prospects.length === 0) {
    console.log(chalk.yellow(`  No verified emails found for ${normalizedDomain}`));
  }

  return prospects;
}

/**
 * Stage 2: Find C-suite/VP decision makers per domain.
 * Two API calls per domain: search-person + bulk-enrich-person.
 */
async function findDecisionMakers(domains, { maxProspects } = {}) {
  const apiKey = process.env.PROSPEO_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PROSPEO_API_KEY in environment variables.');
  }

  const client = axios.create({
    headers: { 'Content-Type': 'application/json', 'X-KEY': apiKey },
    timeout: 60000,
  });

  const allProspects = [];

  for (let i = 0; i < domains.length; i += 1) {
    const domain = domains[i];
    if (i > 0) await sleep(DOMAIN_DELAY_MS);

    try {
      const contactsToFetch = maxProspects ? Math.min(maxProspects - allProspects.length, CONTACTS_PER_DOMAIN) : CONTACTS_PER_DOMAIN;
      const prospects = await findProspectsForDomain(client, domain, {
        maxContacts: Math.max(contactsToFetch, 1),
      });
      allProspects.push(...prospects);
      console.log(
        chalk.green(`  Found ${prospects.length} contact(s) with emails at ${normalizeDomain(domain)}`)
      );

      if (maxProspects && allProspects.length >= maxProspects) {
        console.log(chalk.gray(`  Reached prospect limit (${maxProspects}), stopping search.`));
        break;
      }
    } catch (error) {
      console.log(chalk.red(`  Failed for ${domain}: ${error.message}`));
      if (error.message.includes('rate limit')) break;
    }
  }

  return maxProspects ? allProspects.slice(0, maxProspects) : allProspects;
}

module.exports = { findDecisionMakers };
