require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const axios = require('axios');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Model OpenRouter gratisan yang valid & support gambar (multimodal)
const AI_MODEL = 'inclusionai/ling-3.0-flash-vl:free';

let totalTokensUsed = 0; // Akumulasi hitungan token/kredit AI

// Event saat bot online
client.once('clientReady', () => {
  console.log(`✅ Bot berhasil login sebagai: ${client.user.tag}`);
  client.user.setActivity(`Model: inclusionai/ling-3.0 | Used: 0 Tokens`, { type: 4 });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);

  if (isDM || isMentioned) {
    try {
      // 1. Tampilkan animasi "Bot is typing..."
      await message.channel.sendTyping();

      // 2. Olah Teks Prompt dan Fitur Reply
      let promptText = message.content.replace(`<@${client.user.id}>`, '').trim();
      const contentPayload = [];

      let referencedText = '';
      if (message.reference && message.reference.messageId) {
        try {
          const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
          
          if (referencedMessage.content) {
            referencedText = `[Pesan yang dibalas: "${referencedMessage.content}"]\n\n`;
          }

          if (referencedMessage.attachments.size > 0) {
            referencedMessage.attachments.forEach(attachment => {
              if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                contentPayload.push({
                  type: "image_url",
                  image_url: { url: attachment.url }
                });
              }
            });
          }
        } catch (err) {
          console.log('Gagal mengambil pesan reply:', err.message);
        }
      }

      const fullPrompt = referencedText + promptText;

      if (fullPrompt) {
        contentPayload.push({ type: "text", text: fullPrompt });
      }

      // Olah Gambar dari pesan saat ini
      if (message.attachments.size > 0) {
        message.attachments.forEach(attachment => {
          if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            contentPayload.push({
              type: "image_url",
              image_url: { url: attachment.url }
            });
          }
        });
      }

      // 3. Panggil API OpenRouter (Hanya 1 kali penulisan response)
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: AI_MODEL,
          messages: [
            {
              role: 'user',
              content: contentPayload.length > 0 ? contentPayload : fullPrompt
            }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.AI_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://discord.com',
            'X-OpenRouter-Title': 'Discord AI Bot'
          }
        }
      );

      // Safe-guard jika respon teks dari AI kosong
      const replyFromAI = response.data?.choices?.[0]?.message?.content;

      if (!replyFromAI) {
        await message.reply('⚠️ AI tidak memberikan respon teks. Silakan coba lagi.');
        return;
      }

      // 4. Update pemakaian token & Status Bot
      const tokensThisRequest = response.data.usage?.total_tokens || 0;
      totalTokensUsed += tokensThisRequest;

      client.user.setActivity(
        `Model: inclusionai/ling-3.0 | Used: ${totalTokensUsed.toLocaleString()} Tokens`,
        { type: 4 }
      );

      // 5. Kirim balasan bertahap agar pesan panjang tidak kepotong
      const chunks = replyFromAI.match(/[\s\S]{1,1900}/g) || [replyFromAI];
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await message.reply(chunks[i]);
        } else {
          await message.channel.send(chunks[i]);
        }
      }

    } catch (error) {
      console.error('Error API:', error.response?.data || error.message);
      let errorMsg = '❌ Terjadi kesalahan saat memproses jawaban dari AI.';
      if (error.response?.data?.error?.message) {
        errorMsg += `\n**Detail:** ${error.response.data.error.message}`;
      }
      await message.reply(errorMsg);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);