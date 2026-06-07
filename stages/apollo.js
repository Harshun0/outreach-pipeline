const axios = require('axios');
const chalk = require('chalk');

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const LOOKALIKE_COUNT = 10;
const MAX_RETRIES = 3;

const EMPLOYEE_RANGES = [
  [1, 10],
  [11, 20],
  [21, 50],
  [51, 100],
  [101, 200],
  [201, 500],
  [501, 1000],
  [1001, 2000],
  [2001, 5000],
  [5001, 10000],
  [10001, 20000],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDomain(domain) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function getEmployeeRangeStrings(employeeCount) {
  if (!employeeCount || Number.isNaN(employeeCount)) {
    return ['11,50', '51,200'];
  }

  const index = EMPLOYEE_RANGES.findIndex(
    ([min, max]) => employeeCount >= min && employeeCount <= max
  );

  if (index === -1) {
    return employeeCount > 20000 ? ['10001,20000'] : ['1,10'];
  }

  const ranges = [];
  for (let i = Math.max(0, index - 1); i <= Math.min(EMPLOYEE_RANGES.length - 1, index + 1); i += 1) {
    const [min, max] = EMPLOYEE_RANGES[i];
    ranges.push(`${min},${max}`);
  }

  return [...new Set(ranges)];
}

async function apolloRequest(client, method, url, config = {}) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.request({ method, url, ...config });
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;

      if (status === 429 && attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        console.log(
          chalk.yellow(
            `  Apollo rate limit hit. Retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`
          )
        );
        await sleep(delay);
        continue;
      }

      if (status === 401) {
        throw new Error('Apollo authentication failed. Check APOLLO_API_KEY.');
      }

      if (status === 403) {
        throw new Error(`Apollo access denied: ${message}`);
      }

      if (attempt < MAX_RETRIES && (!status || status >= 500)) {
        const delay = attempt * 1500;
        console.log(
          chalk.yellow(
            `  Apollo request failed (${message}). Retrying in ${delay / 1000}s...`
          )
        );
        await sleep(delay);
        continue;
      }

      throw new Error(`Apollo API error${status ? ` (${status})` : ''}: ${message}`);
    }
  }

  throw lastError;
}

async function enrichSeedCompany(client, domain) {
  console.log(chalk.cyan(`  Enriching seed company: ${domain}`));

  const data = await apolloRequest(client, 'get', `${APOLLO_BASE_URL}/organizations/enrich`, {
    params: { domain },
  });

  if (!data?.organization) {
    throw new Error(`Could not enrich seed company for domain: ${domain}`);
  }

  return data.organization;
}

async function searchSimilarCompanies(client, seedOrg, seedDomain) {
  const params = new URLSearchParams();
  params.append('page', '1');
  params.append('per_page', String(LOOKALIKE_COUNT + 5));

  const employeeRanges = getEmployeeRangeStrings(seedOrg.estimated_num_employees);
  employeeRanges.forEach((range) => {
    params.append('organization_num_employees_ranges[]', range);
  });

  const keywords = (seedOrg.keywords || []).slice(0, 3);
  if (keywords.length === 0 && seedOrg.industry) {
    keywords.push(seedOrg.industry);
  }

  keywords.forEach((keyword) => {
    params.append('q_organization_keyword_tags[]', keyword);
  });

  if (seedOrg.industry) {
    params.append('q_organization_keyword_tags[]', seedOrg.industry);
  }

  console.log(
    chalk.cyan(
      `  Searching lookalikes using ${keywords.length} keyword(s) and employee ranges: ${employeeRanges.join(', ')}`
    )
  );

  const data = await apolloRequest(
    client,
    'post',
    `${APOLLO_BASE_URL}/organizations/search?${params.toString()}`
  );

  const organizations = data.organizations || data.accounts || [];
  const domains = [];

  for (const org of organizations) {
    const candidate =
      org.primary_domain ||
      org.domain ||
      (org.website_url ? normalizeDomain(org.website_url) : null);

    if (!candidate || candidate === seedDomain) {
      continue;
    }

    if (!domains.includes(candidate)) {
      domains.push(candidate);
    }

    if (domains.length >= LOOKALIKE_COUNT) {
      break;
    }
  }

  return domains;
}

/**
 * Stage 1: Find lookalike companies for a seed domain using Apollo.io.
 * Enriches the seed company, then searches for firms with similar firmographics.
 */
async function findLookalikeCompanies(seedDomain) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error('Missing APOLLO_API_KEY in environment variables.');
  }

  const domain = normalizeDomain(seedDomain);
  const client = axios.create({
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': apiKey,
    },
    timeout: 30000,
  });

  const seedOrg = await enrichSeedCompany(client, domain);
  console.log(
    chalk.gray(
      `  Seed: ${seedOrg.name || domain} | Industry: ${seedOrg.industry || 'n/a'} | Employees: ${seedOrg.estimated_num_employees || 'n/a'}`
    )
  );

  let domains = await searchSimilarCompanies(client, seedOrg, domain);

  if (domains.length < LOOKALIKE_COUNT) {
    console.log(
      chalk.yellow(
        `  Only found ${domains.length} lookalikes with keyword filters. Broadening search...`
      )
    );

    const fallbackParams = new URLSearchParams();
    fallbackParams.append('page', '1');
    fallbackParams.append('per_page', String(LOOKALIKE_COUNT + 5));

    getEmployeeRangeStrings(seedOrg.estimated_num_employees).forEach((range) => {
      fallbackParams.append('organization_num_employees_ranges[]', range);
    });

    const fallbackData = await apolloRequest(
      client,
      'post',
      `${APOLLO_BASE_URL}/organizations/search?${fallbackParams.toString()}`
    );

    const fallbackOrgs = fallbackData.organizations || fallbackData.accounts || [];
    for (const org of fallbackOrgs) {
      const candidate =
        org.primary_domain ||
        org.domain ||
        (org.website_url ? normalizeDomain(org.website_url) : null);

      if (!candidate || candidate === domain || domains.includes(candidate)) {
        continue;
      }

      domains.push(candidate);
      if (domains.length >= LOOKALIKE_COUNT) {
        break;
      }
    }
  }

  if (domains.length === 0) {
    throw new Error('No lookalike companies found. Try a different seed domain.');
  }

  return domains.slice(0, LOOKALIKE_COUNT);
}

module.exports = {
  findLookalikeCompanies,
  normalizeDomain,
};
