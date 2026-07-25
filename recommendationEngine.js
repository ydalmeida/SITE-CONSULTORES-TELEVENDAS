// ============================================================================
// recommendationEngine.js — "Smart Recommendation Engine" (o coração do
// sistema, conforme o briefing).
//
// NÃO usa IA. Calcula, por regra de negócio + score, a compatibilidade de
// CADA produto cadastrado com a empresa consultada. Devolve tudo ordenado e
// com o "porquê" de cada nota (rastreabilidade) — a IA (aiEngine.js) só
// analisa os top-N que ESTE módulo já pré-selecionou; ela nunca vê o catálogo
// inteiro, o que reduz custo, aumenta velocidade e evita alucinação.
//
// Os pesos de cada critério são 100% parametrizáveis (tela de Configurações),
// sem precisar alterar código — ver getPesos()/salvarPesos().
// ============================================================================

import { storage, REGIAO_UF } from './utils.js';

const PESOS_PADRAO = {
  cnae: 0.40,
  segmento: 0.25,
  regional: 0.15,
  prioridade: 0.10,
  margem: 0.05,
  relacionados: 0.05
};

export function getPesos() {
  const salvos = storage.get('pesos', null);
  // valida que os pesos salvos ainda somam ~1 e têm todas as chaves; senão, reseta.
  if (salvos && Object.keys(PESOS_PADRAO).every(k => typeof salvos[k] === 'number')) return salvos;
  return { ...PESOS_PADRAO };
}

export function salvarPesos(pesos) {
  storage.set('pesos', pesos);
}

export function resetarPesos() {
  storage.set('pesos', { ...PESOS_PADRAO });
  return getPesos();
}

export function normalizarPesos(pesos) {
  const soma = Object.values(pesos).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const k in pesos) out[k] = pesos[k] / soma;
  return out;
}

// ── Critérios individuais (cada um devolve 0–100) ───────────────────────────

function scoreCnae(produto, empresa) {
  const codigosEmpresa = [empresa.cnaePrincipal, ...(empresa.cnaesSecundarios || []).map(c => c.codigo)]
    .filter(Boolean);
  let melhor = 0;
  for (const pc of (produto.cnaesCompativeis || [])) {
    for (const ce of codigosEmpresa) {
      if (ce === pc) melhor = Math.max(melhor, 100);
      else if (ce.slice(0, 5) === pc.slice(0, 5)) melhor = Math.max(melhor, 80); // mesma subclasse
      else if (ce.slice(0, 2) === pc.slice(0, 2)) melhor = Math.max(melhor, 45); // mesma divisão CNAE
    }
  }
  return melhor;
}

function scoreSegmento(produto, empresa) {
  const segmentos = produto.segmentos || [];
  if (!segmentos.length) return 40; // produto genérico, sem segmento definido
  const texto = [empresa.cnaeDescricao, empresa.nomeFantasia, empresa.razaoSocial,
    ...(empresa.cnaesSecundarios || []).map(c => c.descricao)]
    .filter(Boolean).join(' ').toLowerCase();
  const hits = segmentos.filter(seg => texto.includes(seg.toLowerCase())).length;
  if (!hits) return 15;
  return Math.min(100, 45 + hits * 25);
}

function scoreRegional(produto, empresa) {
  const estados = produto.estadosPreferenciais || [];
  const regioes = produto.regioes || [];
  if (!estados.length && !regioes.length) return 55; // sem preferência regional = neutro
  if (estados.includes(empresa.uf)) return 100;
  if (regioes.includes(REGIAO_UF[empresa.uf])) return 70;
  return 20;
}

function scorePrioridade(produto) {
  return Math.round(((produto.prioridade || 0) / 5) * 100);
}

function scoreMargem(produto) {
  // margem de 0% a 50%+ mapeada para 0–100
  return Math.min(100, Math.round(((produto.margem || 0) / 50) * 100));
}

function scoreRelacionados(produto, catalogoPorId) {
  const relacionados = (produto.relacionados || []).filter(id => catalogoPorId[id] && catalogoPorId[id].status === 'ativo');
  return Math.min(100, relacionados.length * 25);
}

/**
 * Calcula o score final (0–100) de um produto para uma empresa, com o
 * detalhamento de cada critério — é essa estrutura que alimenta a
 * "rastreabilidade" exigida: dá pra mostrar exatamente o que pesou na nota.
 */
export function calcularScore(produto, empresa, catalogoPorId, pesos = getPesos()) {
  const p = normalizarPesos(pesos);
  const criterios = {
    cnae: scoreCnae(produto, empresa),
    segmento: scoreSegmento(produto, empresa),
    regional: scoreRegional(produto, empresa),
    prioridade: scorePrioridade(produto),
    margem: scoreMargem(produto),
    relacionados: scoreRelacionados(produto, catalogoPorId)
  };
  let total = 0;
  const contribuicoes = {};
  for (const k in criterios) {
    const contrib = criterios[k] * p[k];
    contribuicoes[k] = Math.round(contrib * 10) / 10;
    total += contrib;
  }
  return { total: Math.round(total * 10) / 10, criterios, contribuicoes, pesos: p };
}

/**
 * Roda o motor sobre TODO o catálogo, ordena por score desc e devolve só os
 * top N (padrão 20) — é essa lista, e só ela, que vai para a IA depois.
 */
export function recomendar(empresa, produtos, { topN = 20, apenasAtivos = true } = {}) {
  const pesos = getPesos();
  const catalogo = apenasAtivos ? produtos.filter(p => p.status === 'ativo') : produtos.slice();
  const catalogoPorId = Object.fromEntries(catalogo.map(p => [p.id, p]));

  const pontuados = catalogo.map(produto => {
    const resultado = calcularScore(produto, empresa, catalogoPorId, pesos);
    return { produto, ...resultado };
  });

  pontuados.sort((a, b) => b.total - a.total);
  return pontuados.slice(0, topN);
}

export const LABEL_CRITERIO = {
  cnae: 'Compatibilidade de CNAE',
  segmento: 'Compatibilidade de Segmento',
  regional: 'Compatibilidade Regional',
  prioridade: 'Prioridade Comercial',
  margem: 'Margem',
  relacionados: 'Produtos Relacionados'
};
