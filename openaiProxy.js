/**
 * functions/openaiProxy.js
 * ------------------------------------------------------------------
 * Firebase Cloud Function (2nd gen, onRequest) que faz proxy para a
 * OpenAI API. Isso existe por um único motivo: o app roda estático
 * no GitHub Pages, então a OPENAI_API_KEY NUNCA pode ir para o
 * bundle do front-end. Ela vive apenas aqui, como variável de
 * ambiente do servidor.
 *
 * Deploy:
 *   firebase functions:secrets:set OPENAI_API_KEY
 *   firebase deploy --only functions:openaiProxy
 *
 * O front-end (aiEngine.js) chama esta função via POST { system, user }.
 * ------------------------------------------------------------------
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// Ajuste conforme os domínios reais de hospedagem (GitHub Pages + custom domain).
const ALLOWED_ORIGINS = [
  'https://SEU-USUARIO.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

exports.openaiProxy = onRequest(
  { secrets: [OPENAI_API_KEY], cors: ALLOWED_ORIGINS, region: 'southamerica-east1' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const { system, user } = req.body || {};
    if (!system || !user) {
      res.status(400).json({ error: 'Campos "system" e "user" são obrigatórios.' });
      return;
    }

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY.value()}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        res.status(502).json({ error: 'Falha na OpenAI API', detail: errText });
        return;
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content ?? '{}';
      res.status(200).json({ text });
    } catch (e) {
      res.status(500).json({ error: 'Erro interno no proxy da IA.', detail: String(e) });
    }
  }
);
