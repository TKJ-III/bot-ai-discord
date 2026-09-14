require('dotenv').config();
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
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
const AI_MODEL = 'cohere/north-mini-code:free';

let totalTokensUsed = 0; // Akumulasi hitungan token/kredit AI

// Event saat bot online
client.once('clientReady', () => {
  console.log(`✅ Bot berhasil login sebagai: ${client.user.tag}`);
  client.user.setActivity(`Model: cohere/north-mini-code:free | Used: 0 Tokens`, { type: 4 });
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
      const imagePayloads = [];

      let referencedText = '';
      if (message.reference && message.reference.messageId) {
        try {
          const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
          
          if (referencedMessage.content) {
            referencedText = `[Pesan yang dibalas: "${referencedMessage.content}"]\n\n`;
          }

          // Proses gambar dari pesan yang direply
          if (referencedMessage.attachments.size > 0) {
            referencedMessage.attachments.forEach(attachment => {
              if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                imagePayloads.push({
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

      // Olah File dan Gambar dari pesan saat ini (Gunakan for...of untuk mendukung async/await)
      for (const [key, attachment] of message.attachments) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
          // Jika gambar, tambahkan ke payload multimodal
          imagePayloads.push({
            type: "image_url",
            image_url: { url: attachment.url }
          });
        } else if (
          (attachment.contentType && attachment.contentType.startsWith('text/')) || 
          attachment.name.match(/\.(js|ts|py|html|css|json|cpp|txt|md|csv)$/i)
        ) {
          // Jika file berupa teks/kode, kita download isinya dan berikan ke AI untuk dibaca
          try {
            const fileRes = await axios.get(attachment.url, { responseType: 'text' });
            promptText += `\n\n--- Isi dari file lampiran: ${attachment.name} ---\n${fileRes.data}\n--- Akhir dari file ---`;
          } catch (e) {
            console.error(`Gagal mendownload isi file ${attachment.name}:`, e.message);
            promptText += `\n\n[Sistem gagal membaca isi lampiran file ${attachment.name}]`;
          }
        }
      }

      const fullTextPrompt = referencedText + promptText;
      let finalMessageContent;

      if (imagePayloads.length > 0) {
        finalMessageContent = [{ type: "text", text: fullTextPrompt }, ...imagePayloads];
      } else {
        finalMessageContent = fullTextPrompt || "Halo!";
      }

      // 3. Panggil API OpenRouter (Hanya 1 kali penulisan response)
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: AI_MODEL,
          messages: [
            {
              role: 'system',
              content: 'Kamu adalah asisten AI di Discord. Kamu dapat membaca isi file teks/kode yang dikirim pengguna. JIKA kamu ingin memberikan/mengirim file kembali ke pengguna (misalnya file kode script, atau teks panjang), kamu WAJIB menggunakan format berikut dalam jawabanmu:\n\n[FILE:nama_file.ekstensi]\nTulis semua isi file disini...\n[/FILE]\n\nKamu boleh mengirim banyak file dalam satu jawaban dengan menggunakan format tersebut berulang kali.'
            },
            {
              role: 'user',
              content: finalMessageContent
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

      let replyFromAI = response.data?.choices?.[0]?.message?.content;

      if (!replyFromAI) {
        await message.reply('⚠️ AI tidak memberikan respon. Silakan coba lagi.');
        return;
      }

      // 4. Update pemakaian token & Status Bot
      const tokensThisRequest = response.data.usage?.total_tokens || 0;
      totalTokensUsed += tokensThisRequest;

      client.user.setActivity(
        `Model: llama-nemotron-rerank-vl | Used: ${totalTokensUsed.toLocaleString()} Tokens`,
        { type: 4 }
      );

      // 5. Parse jika AI ingin mengirim file menggunakan format [FILE:nama][/FILE]
      const fileRegex = /\[FILE:(.+?)\]([\s\S]*?)\[\/FILE\]/g;
      let match;
      let filesToSend = [];

      // Mengekstrak semua kecocokan format file dari teks AI
      while ((match = fileRegex.exec(replyFromAI)) !== null) {
        const fileName = match[1].trim();
        const fileContent = match[2].trim();
        
        // Ubah teks dari AI menjadi buffer file
        const buffer = Buffer.from(fileContent, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: fileName });
        filesToSend.push(attachment);
      }

      // Hapus tag file dari pesan teks agar chat Discord tetap rapi (tidak ada teks duplikat)
      let cleanReply = replyFromAI.replace(fileRegex, '').trim();
      if (cleanReply === '') cleanReply = '📂 *Mengirimkan file...*'; // Placeholder jika AI hanya merespon file

      // 6. Kirim balasan bertahap agar pesan panjang tidak kepotong
      const chunks = cleanReply.match(/[\s\S]{1,1900}/g) || [cleanReply];
      
      for (let i = 0; i < chunks.length; i++) {
        const isLastChunk = (i === chunks.length - 1);
        
        // Hanya lampirkan file yang digenerate AI pada pesan terakhir/chunk terakhir
        const messageOptions = { content: chunks[i] };
        if (isLastChunk && filesToSend.length > 0) {
          messageOptions.files = filesToSend;
        }

        if (i === 0) {
          await message.reply(messageOptions);
        } else {
          await message.channel.send(messageOptions);
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
