import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('No GEMINI_API_KEY found in .env');
    process.exit(1);
}

const ai = new GoogleGenerativeAI(apiKey);

async function testModel(modelName: string) {
    console.log(`\nTesting ${modelName}...`);
    try {
        const model = ai.getGenerativeModel({ model: modelName });
        const result = await model.generateContent('Say "API is working!"');
        console.log(`✅ Success for ${modelName}:`, result.response.text().trim());
    } catch (error: any) {
        console.error(`❌ Error for ${modelName}:`, error.message);
    }
}

async function run() {
    await testModel('gemini-2.0-flash');
    await testModel('gemini-2.0-flash-lite');
}

run();
