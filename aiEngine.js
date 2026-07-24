/**
 * aiEngine.js — AI SALES SPECIALIST
 * ------------------------------------------------------------------
 * A IA NUNCA vê o catálogo inteiro. Ela recebe apenas os `topForAI`
 * (no máximo 20 itens) já calculados pelo recommendationEngine.js e
 * devolve os 5 melhores, com justificativa comercial.
 *
 * A chamada à OpenAI NÃO é feita diretamente do browser (a chave
 * jamais deve ficar no front-end estático hospedado no GitHub
 * Pages). Este módulo chama a Firebase Function `openaiProxy`, que
 * guarda a API key como variável de ambiente no servidor.
 *
 * Contrato de saída validado em runtime: se a IA tentar devolver um
 * produto fora da lista enviada, ou inventar dados, o item é
 * descartado por `sanitizeAIResponse` — nunca chega à tela.
 * ------------------------------------------------------------------
 */

// Ajuste para a URL da sua Firebase Function em produção.
const OPENAI_PROXY_URL = '/api/openaiProxy';

function buildPrompt(company, topForAI) {
  const produtos = topForAI.map(({ product, score, breakdown }) => ({
    id: product.id,
    nome: product.nome,
    marca: product.marca,
    categoria: product.categoria,
    descricao: product.descricao,
    palavrasChave: product.palavrasChave,
    scoreCalculado: score,
    criteriosScore: breakdown,
  }));

  const system = `Você é um consultor comercial sênior, extremamente experiente, especialista em analisar
o perfil de uma empresa e recomendar os produtos mais adequados dentre uma lista JÁ PRÉ-FILTRADA.

REGRAS OBRIGATÓRIAS (nunca podem ser violadas):
1. Escolha exatamente 5 produtos dentre os fornecidos em "produtosDisponiveis".
2. NUNCA invente produtos que não estejam na lista.
3. NUNCA altere o nome, id ou qualquer dado factual do produto.
4. Baseie sua escolha no perfil da empresa e no scoreCalculado de cada produto, mas você pode
   reordenar dentro do top 20 caso o contexto comercial justifique.
5. Responda APENAS com um JSON válido, sem markdown, sem texto antes ou depois, seguindo exatamente este schema:

{
  "recomendacoes": [
    {
      "id": "id do produto exatamente como recebido",
      "nome": "nome exatamente como recebido",
      "score": number,
      "probabilidadeVenda": "Alta" | "Média" | "Baixa",
      "motivo": "string curta",
      "problemaQueResolve": "string",
      "beneficioCliente": "string",
      "argumentoVenda": "string",
      "produtosComplementares": ["nomes de produtos existentes na lista fornecida"],
      "objecoesComuns": ["string", "string"],
      "sugestaoAbordagem": "string"
    }
  ]
}`;

  const user = JSON.stringify({
    empresa: {
      razaoSocial: company.razaoSocial,
      cidade: company.cidade,
      estado: company.estado,
      cnaeDescricao: company.cnaeDescricao,
      segmento: company.segmento,
      porte: company.porte,
    },
    produtosDisponiveis: produtos,
  });

  return { system, user };
}

/**
 * Remove qualquer item que não corresponda exatamente (por id) a um
 * produto do topForAI original — barreira final contra alucinação.
 */
function sanitizeAIResponse(aiJson, topForAI) {
  const byId = new Map(topForAI.map((r) => [String(r.product.id), r]));
  const recs = Array.isArray(aiJson?.recomendacoes) ? aiJson.recomendacoes : [];

  const clean = recs
    .filter((r) => byId.has(String(r.id)))
    .map((r) => {
      const original = byId.get(String(r.id)).product;
      return {
        ...r,
        id: original.id,
        nome: original.nome, // nunca confia no nome devolvido pela IA
        imagem: original.imagem,
        marca: original.marca,
        categoria: original.categoria,
      };
    })
    .slice(0, 5);

  return clean;
}

/**
 * @param {object} company - normalizado pelo api.js
 * @param {Array} topForAI - saída de recommendationEngine.recommend().topForAI
 * @returns {Promise<Array>} até 5 recomendações finais, sanitizadas
 */
export async function getAIRecommendations(company, topForAI) {
  if (!topForAI || topForAI.length === 0) {
    return [];
  }

  const { system, user } = buildPrompt(company, topForAI);

  const res = await fetch(OPENAI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, user }),
  });

  if (!res.ok) {
    const err = new Error('Falha ao consultar o especialista de IA.');
    err.code = 'AI_PROXY_FAILURE';
    throw err;
  }

  const { text } = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    const err = new Error('A IA retornou um formato inesperado.');
    err.code = 'AI_PARSE_FAILURE';
    err.cause = e;
    throw err;
  }

  return sanitizeAIResponse(parsed, topForAI);
}
