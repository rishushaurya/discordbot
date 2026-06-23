const dotenv = require('dotenv');
dotenv.config();

const db = require('./db');
const groq = require('./groq');

async function runTest() {
  console.log('Testing db connection...');
  await db.initDb();
  console.log('DB init complete.');

  console.log('Testing Groq connection and personality prompt assembly...');
  const guildConfig = await db.getPersonalityConfig('test-guild');
  console.log('Default Guild Config:', guildConfig);

  const messages = [
    { role: 'user', content: 'yo lilgooner, rate my fit, i am wearing a custom tuxedo and crocs' }
  ];

  try {
    const response = await groq.queryGroq(
      messages,
      false, // not owner
      guildConfig,
      'test_user',
      '123456789012345678',
      null, // sender status
      true // useTools = true
    );

    console.log('Groq Response object:');
    console.log(JSON.stringify(response, null, 2));

    if (response.tool_calls) {
      console.log('SUCCESS: Tool calls triggered!');
    } else {
      console.log('SUCCESS: Conversational text response received!');
    }
  } catch (error) {
    console.error('Groq test failed:', error);
  }
}

runTest();
