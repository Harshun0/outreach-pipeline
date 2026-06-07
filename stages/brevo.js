const axios = require('axios');
const chalk = require('chalk');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEmailContent(prospect) {
  const firstName = prospect.name.split(' ')[0] || prospect.name;
  const companyName = prospect.company;

  const subject = `Quick question about ${companyName}`;

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; color: #222; line-height: 1.6;">
        <p>Hi ${firstName},</p>
        <p>
          I came across ${companyName} while researching companies doing impressive work in your space,
          and I wanted to reach out personally.
        </p>
        <p>
          I'm with a growth-focused SaaS company helping teams streamline outbound and partnership
          conversations. Based on what ${companyName} is building, I think there could be a strong fit
          for a quick partnership or product demo conversation.
        </p>
        <p>
          Would you be open to a 15-minute chat next week to explore whether this could be valuable
          for your team?
        </p>
        <p>
          Best,<br />
          ${process.env.SENDER_NAME || 'Growth Team'}
        </p>
      </body>
    </html>
  `.trim();

  const textContent = [
    `Hi ${firstName},`,
    '',
    `I came across ${companyName} while researching companies doing impressive work in your space, and I wanted to reach out personally.`,
    '',
    `I'm with a growth-focused SaaS company helping teams streamline outbound and partnership conversations. Based on what ${companyName} is building, I think there could be a strong fit for a quick partnership or product demo conversation.`,
    '',
    'Would you be open to a 15-minute chat next week to explore whether this could be valuable for your team?',
    '',
    `Best,`,
    process.env.SENDER_NAME || 'Growth Team',
  ].join('\n');

  return { subject, htmlContent, textContent };
}

async function sendEmail(client, prospect) {
  const senderEmail = process.env.SENDER_EMAIL;
  const senderName = process.env.SENDER_NAME || 'Outreach';

  if (!senderEmail) {
    throw new Error('Missing SENDER_EMAIL in environment variables.');
  }

  const { subject, htmlContent, textContent } = buildEmailContent(prospect);

  const payload = {
    sender: {
      name: senderName,
      email: senderEmail,
    },
    to: [
      {
        email: prospect.email,
        name: prospect.name,
      },
    ],
    subject,
    htmlContent,
    textContent,
  };

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.post(BREVO_API_URL, payload);
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;

      if (status === 429 && attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        console.log(
          chalk.yellow(
            `  Brevo rate limit hit for ${prospect.email}. Retrying in ${delay / 1000}s...`
          )
        );
        await sleep(delay);
        continue;
      }

      if (status === 401) {
        throw new Error('Brevo authentication failed. Check BREVO_API_KEY.');
      }

      if (attempt < MAX_RETRIES && (!status || status >= 500)) {
        const delay = attempt * 1500;
        console.log(
          chalk.yellow(`  Brevo send failed (${message}). Retrying in ${delay / 1000}s...`)
        );
        await sleep(delay);
        continue;
      }

      throw new Error(`Brevo API error${status ? ` (${status})` : ''}: ${message}`);
    }
  }

  throw lastError;
}

/**
 * Stage 4: Send personalized outreach emails via Brevo transactional API.
 */
async function sendOutreachEmails(prospects) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('Missing BREVO_API_KEY in environment variables.');
  }

  const client = axios.create({
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    timeout: 30000,
  });

  const results = {
    sent: 0,
    failed: 0,
    errors: [],
  };

  for (const prospect of prospects) {
    try {
      console.log(chalk.cyan(`  Sending to ${prospect.name} <${prospect.email}>...`));
      await sendEmail(client, prospect);
      results.sent += 1;
      console.log(chalk.green(`  Sent to ${prospect.email}`));
    } catch (error) {
      results.failed += 1;
      results.errors.push({ prospect, error: error.message });
      console.log(chalk.red(`  Failed for ${prospect.email}: ${error.message}`));
    }
  }

  return results;
}

module.exports = {
  sendOutreachEmails,
  buildEmailContent,
};
