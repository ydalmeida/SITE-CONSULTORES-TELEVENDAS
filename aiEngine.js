// ============================================================================
// aiEngine.js — "AI Sales Specialist"
//
// Regra de ouro do briefing: a IA NUNCA vê o catálogo inteiro. Ela recebe só
// os top-N (padrão 20) já selecionados pelo recommendationEngine.js, escolhe
// os 5 melhores entre ELES (nunca inventa produto fora da lista) e devolve,
// para cada um: motivo, problema que resolve, benefício, argumento de venda,
// complementares, objeções comuns e sugestão de abordagem.
//
// Funciona em dois modos, sem exigir nenhuma configuração:
//   1) MODO IA (se houver uma chave/proxy configurado em Configurações):
//      chama um endpoint compatível com a Chat Completions API da OpenAI
//      (funciona com a OpenAI de verdade OU com o proxy simples que está em
//      /functions/openaiProxy.js — recomendado em produção, pra não expor a
//      chave no navegador).
//   2) MODO REGRAS (padrão, sem nenhuma chave): gera a mesma estrutura de
//      resposta a partir do score/])criterios já calculados pelo motor de
//      regras. Não é "menos inteligente à toa" — é o que garante que o app
//      funcione 100% pronto pra uso, sem depender de custo/latência externa.
// ============================================================================

import { storage, formatarMoeda } from './utils.js';
import { LABEL_CRITERIO } from './recommendationEngine.js';

export function getConfigIA() {
  return storage.get('configIA', { endpoint: '', apiKey: '', modelo: 'gpt-4o-mini', ativo: false });
}
export function salvarConfigIA(cfg) { storage.set('configIA', cfg); }

/**
 * @param {Empresa} empresa
 * @param {Array} top20  — saída de recommendationEngine.recomendar()
 * @returns {Promise<Array>} os 5 melhores, no formato exigido pelo briefing
 */
export async function gerarRecomendacaoFinal(empresa, top20) {
  const cfg = getConfigIA();
  if (cfg.ativo && (cfg.endpoint || cfg.apiKey)) {
    try {
      return await gerarViaIA(empresa, top20, cfg);
    } catch (e) {
      console.warn('IA indisponível, usando fallback por regras:', e.message);
      return gerarViaRegras(empresa, top20, `IA indisponível (${e.message}) — recomendação gerada pelo motor de regras.`);
    }
  }
  return gerarViaRegras(empresa, top20);
}

// ── MODO IA ──────────────────────────────────────────────────────────────
async function gerarViaIA(empresa, top20, cfg) {
  const url = cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
  const listaProdutos = top20.map(({ produto, total, criterios }) => ({
    id: produto.id, nome: produto.nome, categoria: produto.categoria, marca: produto.marca,
    scoreRegras: total, criterios
  }));

  const prompt = montarPrompt(empresa, listaProdutos);

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const resp = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: cfg.modelo || 'gpt-4o-mini',
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Você é um consultor comercial B2B extremamente experiente. Responda SEMPRE em JSON válido, em português do Brasil, e use apenas produtos da lista recebida — nunca invente produtos, nunca altere nomes.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const texto = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(texto);
  const escolhidos = Array.isArray(parsed.recomendacoes) ? parsed.recomendacoes : [];

  // Blindagem: garante que a IA só devolveu produtos que realmente estavam
  // no top20 — qualquer id fora disso é descartado (nunca confiamos cegamente).
  const porId = Object.fromEntries(top20.map(x => [x.produto.id, x]));
  const validados = escolhidos
    .filter(r => porId[r.id])
    .slice(0, 5)
    .map(r => montarCard(porId[r.id], {
      probabilidade: r.probabilidade_venda ?? estimarProbabilidade(porId[r.id].total),
      motivo: r.motivo, problemaResolve: r.problema_que_resolve, beneficio: r.beneficio,
      argumento: r.argumento_de_venda, objecoes: r.objecoes_comuns || [],
      abordagem: r.sugestao_abordagem, complementares: r.produtos_complementares || []
    }));

  return validados.length ? validados : gerarViaRegras(empresa, top20, 'A IA não retornou recomendações válidas — usando o motor de regras.');
}

function montarPrompt(empresa, listaProdutos) {
  return `Empresa consultada:
- Razão social: ${empresa.razaoSocial}
- Nome fantasia: ${empresa.nomeFantasia || '—'}
- Cidade/UF: ${empresa.municipio}/${empresa.uf}
- CNAE principal: ${empresa.cnaePrincipal} — ${empresa.cnaeDescricao}
- Porte: ${empresa.porte}
- Situação cadastral: ${empresa.situacao}

Produtos pré-selecionados pelo motor de regras (analise SOMENTE estes, escolha os 5 melhores):
${JSON.stringify(listaProdutos, null, 0)}

Responda em JSON no formato:
{"recomendacoes":[{"id":"P001","probabilidade_venda":87,"motivo":"...","problema_que_resolve":"...","beneficio":"...","argumento_de_venda":"...","produtos_complementares":["P002"],"objecoes_comuns":["...","..."],"sugestao_abordagem":"..."}]}
Escolha exatamente 5 produtos (ou menos, se a lista tiver menos de 5), ordenados do melhor para o pior. Use somente os IDs recebidos.`;
}

// ── MODO REGRAS (fallback determinístico, sempre disponível) ───────────────
function gerarViaRegras(empresa, top20, notaFallback = null) {
  const top5 = top20.slice(0, 5);
  const porId = Object.fromEntries(top20.map(x => [x.produto.id, x]));

  return top5.map(item => {
    const { produto, criterios, total } = item;
    const motivos = [];
    if (criterios.cnae >= 80) motivos.push(`forte aderência ao CNAE da empresa (${criterios.cnae}/100)`);
    else if (criterios.cnae >= 45) motivos.push(`aderência parcial ao ramo de atividade (${criterios.cnae}/100)`);
    if (criterios.segmento >= 70) motivos.push(`segmento muito compatível (${criterios.segmento}/100)`);
    if (criterios.regional >= 70) motivos.push(`forte presença comercial na região (${criterios.regional}/100)`);
    if (criterios.prioridade >= 80) motivos.push('produto de alta prioridade comercial');
    const motivo = motivos.length
      ? `Recomendado por ${motivos.join(', ')}.`
      : `Produto com aderência geral de ${total}/100 ao perfil da empresa.`;

    const complementares = (produto.relacionados || [])
      .filter(id => porId[id]).slice(0, 3).map(id => porId[id].produto.id);

    return montarCard(item, {
      probabilidade: estimarProbabilidade(total),
      motivo: notaFallback ? `${motivo} ${notaFallback}` : motivo,
      problemaResolve: produto.descricao,
      beneficio: `Rende operacional e financeiramente para o cliente — margem de referência de ${produto.margem}% e ticket médio de ${formatarMoeda(produto.preco)}.`,
      argumento: `${produto.nome} tem alta aderência ao perfil de ${empresa.municipio}/${empresa.uf} e ao ramo "${empresa.cnaeDescricao}". É uma entrada natural de pedido, com espaço para cross-sell.`,
      objecoes: objecoesPadrao(produto),
      abordagem: `Apresente ${produto.nome} associando o problema que ele resolve à rotina do CNAE "${empresa.cnaeDescricao}", e ofereça os produtos complementares como parte de um pedido único.`,
      complementares
    });
  });
}

function objecoesPadrao(produto) {
  const base = ['Preço acima do praticado hoje pelo cliente', 'Já tem fornecedor fixo para a categoria'];
  if (produto.margem < 15) base.push('Margem apertada para negociação de desconto');
  if (produto.categoria) base.push(`Dúvida sobre giro de "${produto.categoria}" no ponto de venda`);
  return base.slice(0, 3);
}

function estimarProbabilidade(scoreTotal) {
  return Math.max(5, Math.min(97, Math.round(scoreTotal)));
}

function montarCard(item, campos) {
  const { produto, total, criterios } = item;
  return {
    id: produto.id,
    nome: produto.nome,
    categoria: produto.categoria,
    marca: produto.marca,
    imagem: produto.imagem,
    preco: produto.preco,
    score: total,
    criterios,
    labelsCriterios: LABEL_CRITERIO,
    probabilidade: campos.probabilidade,
    motivo: campos.motivo,
    problemaResolve: campos.problemaResolve,
    beneficio: campos.beneficio,
    argumento: campos.argumento,
    objecoes: campos.objecoes,
    abordagem: campos.abordagem,
    complementares: campos.complementares
  };
}
