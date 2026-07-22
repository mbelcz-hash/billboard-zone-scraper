zone-scraper-system.js
/**
 * BILLBOARD ZONE CHANGE SCRAPER SYSTEM
 * 
 * This system monitors municipal websites and ecode360.com for zoning changes
 * that affect billboard opportunities. Runs on AWS Lambda weekly (or on-demand).
 * 
 * SETUP:
 * 1. npm install axios cheerio node-schedule dotenv anthropic
 * 2. Add to .env: ANTHROPIC_API_KEY, DATABASE_URL, TWILIO_ACCOUNT_SID, etc.
 * 3. Deploy to AWS Lambda or run locally via node zone-scraper-system.js
 */

const axios = require('axios');
const cheerio = require('cheerio');
const schedule = require('node-schedule');
const { Anthropic } = require('@anthropic-ai/sdk');
require('dotenv').config();

// ============================================================================
// CONFIGURATION: Add/Remove municipalities here
// ============================================================================

const MUNICIPALITIES = [
  {
    name: 'Town of Thompson, NY',
    boardMeetingURL: 'https://townofthompson.gov/meetings',
    ecodeID: 'town-of-thompson',
    state: 'NY',
    corridor: 'Route 17 NY',
    keywords: ['billboard', 'overlay', 'commercial', 'highway', 'zoning amendment']
  },
  {
    name: 'Village of Bloomingburg, NY',
    boardMeetingURL: 'https://villageofbloomingburg.gov/board-meetings',
    ecodeID: 'village-of-bloomingburg',
    state: 'NY',
    corridor: 'Route 17 NY',
    keywords: ['billboard', 'sign', 'commercial', 'gateway', 'ordinance']
  },
  {
    name: 'Town of Goshen, NY',
    boardMeetingURL: 'https://town-of-goshen.gov/meetings',
    ecodeID: 'town-of-goshen',
    state: 'NY',
    corridor: 'Route 17 NY',
    keywords: ['billboard', 'overlay', 'district', 'route 17', 'commercial']
  },
  {
    name: 'Town of Wallkill, NY',
    boardMeetingURL: 'https://town-of-wallkill.gov/planning-board',
    ecodeID: 'town-of-wallkill',
    state: 'NY',
    corridor: 'Route 17 NY',
    keywords: ['billboard', 'setback', 'commercial', 'zoning']
  },
  {
    name: 'Town of Monticello, NY',
    boardMeetingURL: 'https://townofmonticello.gov/board-agendas',
    ecodeID: 'town-of-monticello',
    state: 'NY',
    corridor: 'Route 17 NY',
    keywords: ['billboard', 'commercial', 'overlay', 'gateway']
  },
];

// ============================================================================
// SIMULATED DATABASE (Replace with PostgreSQL in production)
// ============================================================================

let zoneChangeDatabase = {
  changes: [],
  lastChecked: new Date()
};

// ============================================================================
// CLAUDE API CLIENT
// ============================================================================

const client = new Anthropic();

async function analyzeZoningChange(content, municipality) {
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `
            You are a municipal zoning expert analyzing town board documents for billboard opportunities.
            
            MUNICIPALITY: ${municipality}
            
            DOCUMENT CONTENT:
            ${content.substring(0, 3000)} ... [truncated]
            
            ANALYZE FOR BILLBOARD-RELATED ZONING CHANGES:
            
            Look for any mention of:
            - Billboard ordinances or size changes
            - Zoning overlays (especially "commercial overlay" or "gateway district")
            - Setback reductions that would allow billboards
            - Residential → Commercial zone changes in highway-adjacent areas
            - Sign regulations or advertising structure changes
            
            Return ONLY a JSON object (no markdown, no explanation):
            {
              "hasZoningChange": boolean,
              "changeType": "Billboard Size Increase" | "Overlay District" | "Zone Reclassification" | "Setback Reduction" | "Other" | null,
              "status": "DRAFT" | "PROPOSED" | "APPROVED" | "REJECTED" | "NONE",
              "description": "Clear description of change",
              "affectedProperties": number (estimate),
              "potentialValue": number (estimate in dollars),
              "nextMeetingDate": "YYYY-MM-DD" (if vote pending),
              "approvalChance": number (0-100, your estimate),
              "votingPattern": "5-0 Support" | "4-1 Support" | "3-2 Mixed" | "Unknown",
              "keyQuotes": ["quote1", "quote2"],
              "recommendedAction": "Contact owners now" | "Monitor vote" | "Wait for approval" | "Not viable",
              "confidence": number (0-100)
            }
            
            Be conservative with estimates. If you're not sure, say "Unknown".
          `
        }
      ]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error('Failed to parse Claude response as JSON:', parseError);
      return {
        hasZoningChange: false,
        status: 'ERROR',
        description: 'Failed to parse zoning information',
        confidence: 0
      };
    }
  } catch (error) {
    console.error('Claude API error:', error);
    throw error;
  }
}

// ============================================================================
// SCRAPER 1: Town Board Meeting Agendas
// ============================================================================

async function scrapeBoardMeetingAgendas(municipality) {
  console.log(`\n📋 Scraping ${municipality.name} board meetings...`);

  try {
    const response = await axios.get(municipality.boardMeetingURL, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const agendas = [];

    $('a, .agenda, .meeting-item').each((index, element) => {
      const $el = $(element);
      const text = $el.text();
      const href = $el.attr('href');

      const hasKeyword = municipality.keywords.some(kw => 
        text.toLowerCase().includes(kw.toLowerCase())
      );

      if (hasKeyword || text.includes('Agenda') || text.includes('Meeting')) {
        agendas.push({
          text: text.trim().substring(0, 200),
          url: href ? new URL(href, municipality.boardMeetingURL).href : null,
          date: extractDate(text),
          type: 'board_meeting'
        });
      }
    });

    console.log(`✓ Found ${agendas.length} potential zoning-related agenda items`);
    return agendas;

  } catch (error) {
    console.error(`✗ Error scraping ${municipality.name}:`, error.message);
    return [];
  }
}

function extractDate(text) {
  const datePatterns = [
    /(\w+\s+\d{1,2},?\s+\d{4})/,
    /(\d{1,2}\/\d{1,2}\/\d{2,4})/,
    /(\d{4}-\d{2}-\d{2})/
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ============================================================================
// SCRAPER 2: Municipal Zoning Codes (via ecode360.com)
// ============================================================================

async function scrapeEcode360ZoningCode(municipality) {
  console.log(`\n📖 Scraping ${municipality.name} zoning code from ecode360...`);

  try {
    const ecodeURL = `https://ecode360.com/${municipality.ecodeID}`;
    
    const response = await axios.get(ecodeURL, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const codeItems = [];

    $('article, .chapter, .section, [data-section]').each((index, element) => {
      const $el = $(element);
      const text = $el.text();

      const isBillboardRelated = text.toLowerCase().includes('billboard') ||
                                  text.toLowerCase().includes('advertisement') ||
                                  text.toLowerCase().includes('sign') ||
                                  text.toLowerCase().includes('display');

      if (isBillboardRelated) {
        codeItems.push({
          title: $el.find('h2, h3, .title').text().trim() || 'Untitled Section',
          content: text.substring(0, 500),
          url: ecodeURL,
          type: 'zoning_code'
        });
      }
    });

    console.log(`✓ Found ${codeItems.length} zoning code sections related to billboards`);
    return codeItems;

  } catch (error) {
    console.error(`✗ Error scraping ecode360 for ${municipality.name}:`, error.message);
    return [];
  }
}

// ============================================================================
// MAIN SCRAPER ORCHESTRATOR
// ============================================================================

async function scanMunicipality(municipality) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 SCANNING: ${municipality.name}`);
  console.log(`${'='.repeat(60)}`);

  const results = {
    municipality: municipality.name,
    corridor: municipality.corridor,
    timestamp: new Date().toISOString(),
    boardAgendas: [],
    zoningCodes: [],
    analysis: null,
    alerts: []
  };

  try {
    results.boardAgendas = await scrapeBoardMeetingAgendas(municipality);
    results.zoningCodes = await scrapeEcode360ZoningCode(municipality);

    if (results.boardAgendas.length > 0 || results.zoningCodes.length > 0) {
      const combinedContent = [
        ...results.boardAgendas.map(a => a.text),
        ...results.zoningCodes.map(z => z.content)
      ].join('\n\n');

      console.log(`\n🤖 Analyzing with Claude API...`);
      results.analysis = await analyzeZoningChange(combinedContent, municipality.name);

      if (results.analysis.hasZoningChange) {
        results.alerts.push({
          severity: results.analysis.approvalChance >= 75 ? 'CRITICAL' : 'HIGH',
          message: `${results.analysis.changeType} detected in ${municipality.name}. ${results.analysis.approvalChance}% approval chance.`,
          action: results.analysis.recommendedAction,
          affectedProperties: results.analysis.affectedProperties,
          potentialValue: results.analysis.potentialValue
        });
      }
    }

    zoneChangeDatabase.changes.push(results);
    zoneChangeDatabase.lastChecked = new Date();

    console.log(`\n✅ COMPLETE: ${municipality.name}`);
    if (results.alerts.length > 0) {
      console.log(`🚨 ALERTS FOUND: ${results.alerts.length}`);
      results.alerts.forEach(alert => console.log(`   - [${alert.severity}] ${alert.message}`));
    }

  } catch (error) {
    console.error(`❌ Error scanning ${municipality.name}:`, error);
    results.error = error.message;
  }

  return results;
}

// ============================================================================
// ALERT SYSTEM
// ============================================================================

async function sendAlerts(allResults) {
  const criticalAlerts = allResults
    .filter(r => r.alerts && r.alerts.some(a => a.severity === 'CRITICAL'))
    .flatMap(r => r.alerts.map(a => ({ ...a, municipality: r.municipality })));

  const highAlerts = allResults
    .filter(r => r.alerts && r.alerts.some(a => a.severity === 'HIGH'))
    .flatMap(r => r.alerts.map(a => ({ ...a, municipality: r.municipality })));

  if (criticalAlerts.length > 0) {
    console.log(`\n🚨 CRITICAL ALERTS TO SEND:\n`);
    criticalAlerts.forEach(alert => {
      console.log(`
📍 ${alert.municipality}
🔥 ${alert.message}
💰 Potential Value: $${alert.potentialValue.toLocaleString()}
📊 Affected Properties: ${alert.affectedProperties}
✅ Action: ${alert.action}
      `);
    });
  }

  if (highAlerts.length > 0) {
    console.log(`\n⚠️ HIGH PRIORITY ALERTS:\n`);
    highAlerts.forEach(alert => {
      console.log(`   ${alert.municipality}: ${alert.message}`);
    });
  }

  return { criticalAlerts, highAlerts };
}

// ============================================================================
// FULL SCAN EXECUTION
// ============================================================================

async function runFullCorridorScan(corridor = 'Route 17 NY') {
  console.log(`\n${'#'.repeat(70)}`);
  console.log(`# BILLBOARD ZONE CHANGE SCAN - ${corridor}`);
  console.log(`# Started: ${new Date().toISOString()}`);
  console.log(`${'#'.repeat(70)}`);

  const targetMunicipalities = MUNICIPALITIES.filter(m => m.corridor === corridor);
  const results = [];

  for (const municipality of targetMunicipalities) {
    const result = await scanMunicipality(municipality);
    results.push(result);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log(`\n${'#'.repeat(70)}`);
  console.log(`# ALERTS PROCESSING`);
  console.log(`$
