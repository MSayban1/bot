import dotenv from 'dotenv';
import axios from 'axios';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

dotenv.config();

// --- Configuration ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const RECEIVER_EMAIL = process.env.RECEIVER_EMAIL;
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'history.json');

// --- State Management ---
const app = express();
let logs = [];
let nextRunTime = null;
let currentGeneration = ""; // Store live AI output

// --- Logger Helper ---
function log(message, type = 'info') {
    const timestamp = new Date();
    // Console output
    const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
    console.log(`${icon} [${timestamp.toLocaleTimeString()}] ${message}`);

    // Store in memory (keep last 100 logs)
    logs.push({ message, type, timestamp });
    if (logs.length > 100) logs.shift();
}

// --- Express Server ---
app.use(express.static('public'));

app.get('/api/data', (req, res) => {
    let dashboardHistory = [];
    try {
        if (fs.existsSync(path.join(__dirname, 'dashboard_history.json'))) {
            dashboardHistory = JSON.parse(fs.readFileSync(path.join(__dirname, 'dashboard_history.json'), 'utf8'));
        }
    } catch (e) { }

    res.json({
        logs,
        history: dashboardHistory,
        nextRun: nextRunTime,
        currentGeneration // Send live text to frontend
    });
});

app.listen(PORT, () => {
    log(`Dashboard running at http://localhost:${PORT}`, 'success');
});

// Validate Environment Variables
if (!OPENROUTER_API_KEY || !EMAIL_USER || !EMAIL_PASS || !RECEIVER_EMAIL) {
    log('Error: Missing required environment variables. Please check your .env file.', 'error');
    process.exit(1);
}

// --- Nodemailer Transporter (Gmail) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
});
log('Using Gmail Service');

// --- History Management ---
function getPastHeadlines() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        log('Error reading history file: ' + error.message, 'error');
    }
    return [];
}

function saveHeadlines(newsItems) {
    try {
        // 1. Save Titles for Deduplication
        let history = getPastHeadlines();
        const newTitles = newsItems.map(n => n.title);
        history = [...history, ...newTitles];
        if (history.length > 50) history = history.slice(history.length - 50);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

        // 2. Save Full Objects for Dashboard
        const DASHBOARD_FILE = path.join(__dirname, 'dashboard_history.json');
        let dashboardHistory = [];
        if (fs.existsSync(DASHBOARD_FILE)) {
            dashboardHistory = JSON.parse(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
        }
        dashboardHistory = [...dashboardHistory, ...newsItems];
        if (dashboardHistory.length > 20) dashboardHistory = dashboardHistory.slice(dashboardHistory.length - 20); // Keep last 20 for display
        fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashboardHistory, null, 2));

    } catch (error) {
        log('Error saving history: ' + error.message, 'error');
    }
}

// --- Fetch News Function (Non-Streaming for Reliability) ---
async function fetchNews(pastHeadlines) {
    try {
        log('Fetching latest news from OpenRouter (Perplexity)...');
        currentGeneration = "AI is thinking and searching for news... (Streaming disabled for stability)";

        const excludeList = pastHeadlines.join(', ');

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'perplexity/sonar',
                messages: [
                    {
                        role: 'system',
                        content: "You are a helpful news assistant that outputs ONLY valid JSON."
                    },
                    {
                        role: 'user',
                        content: `Fetch 3 recent "Good News" and 3 recent "Shocking News" in **Urdu**.
                        
                        Current Date: ${new Date().toLocaleString()}
                        
                        Constraints:
                        1. Output MUST be a single valid JSON object.
                        2. NO markdown formatting (no \`\`\`json).
                        3. NO conversational text before or after the JSON.
                        4. Do NOT repeat these stories: [${excludeList}]
                        
                        Required JSON Structure:
                        {
                          "news": [
                            { "title": "Urdu Headline", "summary": "Short Urdu summary", "type": "good" },
                            { "title": "Urdu Headline", "summary": "Short Urdu summary", "type": "shocking" }
                          ]
                        }`
                    }
                ],
                max_tokens: 2000,
                stream: false // Disabled to fix empty response issue
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/your-repo',
                    'X-Title': 'Auto Newsletter Bot'
                }
            }
        );

        if (!response.data || !response.data.choices || response.data.choices.length === 0) {
            throw new Error('Invalid API response structure');
        }

        const fullContent = response.data.choices[0].message.content;
        currentGeneration = fullContent; // Show full result in dashboard
        log('AI Generation Complete.');

        // --- Robust JSON Extraction ---
        let jsonString = fullContent.trim();

        // 1. Remove markdown code blocks if present
        jsonString = jsonString.replace(/```json/g, '').replace(/```/g, '');

        // 2. Find the first '{' and last '}' to ignore intro/outro text
        const firstOpen = jsonString.indexOf('{');
        const lastClose = jsonString.lastIndexOf('}');

        if (firstOpen !== -1 && lastClose !== -1) {
            jsonString = jsonString.substring(firstOpen, lastClose + 1);
        }

        try {
            const parsed = JSON.parse(jsonString);
            if (!parsed.news || !Array.isArray(parsed.news)) {
                throw new Error("Missing 'news' array in JSON");
            }
            return parsed.news;
        } catch (e) {
            log('❌ JSON Parse Error. Raw Output:', 'error');
            console.log(fullContent);
            return null;
        }

    } catch (error) {
        log('Error fetching news: ' + error.message, 'error');
        if (error.response) {
            log(`API Status: ${error.response.status}`, 'error');
            console.log(error.response.data);
        }
        return null;
    }
}

// --- HTML Generator ---
function generateHtml(newsItems) {
    const goodNews = newsItems.filter(item => item.type === 'good');
    const shockingNews = newsItems.filter(item => item.type === 'shocking');

    // Professional News Icon
    const LOGO_URL = "https://cdn-icons-png.flaticon.com/512/3208/3208726.png";

    const createCard = (item, color) => `
        <div style="background: #fff; border-right: 4px solid ${color}; padding: 15px; margin-bottom: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
            <h3 style="margin: 0 0 8px 0; color: #333; font-size: 18px;">${item.title}</h3>
            <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.5;">${item.summary}</p>
        </div>
    `;

    return `
        <!DOCTYPE html>
        <html lang="ur" dir="rtl">
        <head>
            <meta charset="UTF-8">
        </head>
        <body style="font-family: 'Arial', sans-serif; background-color: #f4f4f4; margin: 0; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; padding: 0; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); overflow: hidden;">
                
                <!-- Header with Logo -->
                <div style="background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%); padding: 30px 20px; text-align: center;">
                    <img src="${LOGO_URL}" alt="NovaBot Logo" style="width: 64px; height: 64px; margin-bottom: 10px; background: white; padding: 8px; border-radius: 50%;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">NovaBot News</h1>
                    <p style="color: #aaccff; margin: 5px 0 0 0; font-size: 14px;">${new Date().toLocaleString()}</p>
                </div>

                <div style="padding: 20px;">
                    <h2 style="color: #333; text-align: center; margin-bottom: 25px; font-size: 18px; border-bottom: 1px solid #eee; padding-bottom: 10px;">📰 تازہ ترین خبریں (Latest Updates)</h2>

                    ${goodNews.length > 0 ? `
                        <h3 style="color: #27ae60; margin-top: 10px; display: flex; align-items: center; gap: 10px;">
                            <span>💚</span> خوشخبری (Good News)
                        </h3>
                        ${goodNews.map(item => createCard(item, '#27ae60')).join('')}
                    ` : ''}

                    ${shockingNews.length > 0 ? `
                        <h3 style="color: #c0392b; margin-top: 30px; display: flex; align-items: center; gap: 10px;">
                            <span>⚠️</span> لرزہ خیز خبریں (Shocking News)
                        </h3>
                        ${shockingNews.map(item => createCard(item, '#c0392b')).join('')}
                    ` : ''}
                </div>

                <!-- Footer -->
                <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee; color: #888; font-size: 12px;">
                    <p style="margin: 0;">Automated by <strong>NovaBot</strong></p>
                    <p style="margin: 5px 0 0 0;">Powered by OpenRouter & Node.js</p>
                </div>
            </div>
        </body>
        </html>
    `;
}

// --- Send Email Function ---
async function sendEmail(htmlContent) {
    if (!htmlContent) return;

    const mailOptions = {
        from: `"Auto Newsletter Bot" <${EMAIL_USER}>`,
        to: RECEIVER_EMAIL,
        subject: `📰 تازہ ترین خبریں (News Update) - ${new Date().toLocaleString()}`,
        html: htmlContent
    };

    try {
        log('Sending email...');
        const info = await transporter.sendMail(mailOptions);
        log('Email sent successfully! ID: ' + info.messageId, 'success');
    } catch (error) {
        log('Error sending email: ' + error.message, 'error');
    }
}

// --- Main Bot Logic ---
async function runBot() {
    log('--------------------------------------------------');
    log('Bot Routine Started');

    const pastHeadlines = getPastHeadlines();
    const newsItems = await fetchNews(pastHeadlines);

    if (newsItems && newsItems.length > 0) {
        const html = generateHtml(newsItems);
        await sendEmail(html);
        saveHeadlines(newsItems); // Save full items now
        log('Saved new headlines to history.', 'success');
    } else {
        log('No valid news found or API error.', 'info');
    }

    // Set next run time
    const now = new Date();
    nextRunTime = new Date(now.getTime() + 10 * 60000); // +10 minutes
    log('Routine finished. Waiting for next schedule...', 'info');
}

// --- Schedule ---
cron.schedule('*/10 * * * *', () => {
    runBot();
});

// --- Start Message ---
log('🚀 Auto Newsletter Bot is running (OpenRouter API)...');
log('📅 Scheduled to run every 10 minutes.');
log(`📊 Dashboard available at http://localhost:${PORT}`);

// Initial run
runBot();
