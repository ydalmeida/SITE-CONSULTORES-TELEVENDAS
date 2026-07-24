/**
 * recommendationEngine.js
 * ------------------------------------------------------------------
 * SMART RECOMMENDATION ENGINE — o coração do Smart Seller AI.
 *
 * Responsabilidade única: calcular um Score (0-100) para CADA produto
 * do catálogo, com base no perfil da empresa consultada (CNAE,
 * segmento, região, etc.), SEM usar IA generativa.
 *
 * A IA (aiEngine.js) nunca recebe o catálogo inteiro — apenas o
 * TOP_N calculado aqui. Isso é o que garante custo baixo, velocidade
 * e impede a IA de "inventar" produtos fora do catálogo real.
 *
 * Todo o cálculo é rastreável: cada produto retorna um objeto
 * `breakdown` mostrando exatamente quanto cada critério contribuiu
 * para o score final.
 * ------------------------------------------------------------------
 */

/**
 * Pesos padrão dos critérios de score.
 * Parametrizável em tempo de execução (ver loadWeights/saveWeights) —
 * NUNCA é necessário alterar código para mudar a estratégia comercial.
 * A soma deve ser 100, mas normalizamos de qualquer forma por segurança.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  cnae: 40,
  segmento: 25,
  regional: 15,
  prioridade: 10,
  margem: 5,
  relacionados: 5,
});

const WEIGHTS_STORAGE_KEY = 'ssai:recommendation-weights';
const TOP_N_FOR_AI = 20;

/**
 * Carrega os pesos configurados (localStorage) ou usa o padrão.
 * Pensado para futuramente vir do Firestore (/settings).
 */
export function loadWeights() {
  try {
    const raw = localStorage.getItem(WEIGHTS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WEIGHTS };
    const parsed = JSON.parse(raw);
    return normalizeWeights({ ...DEFAULT_WEIGHTS, ...parsed });
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export function saveWeights(weights) {
  const normalized = normalizeWeights(weights);
  localStorage.setItem(WEIGHTS_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const factor = 100 / total;
  const normalized = {};
  for (const key of Object.keys(weights)) {
    normalized[key] = weights[key] * factor;
  }
  return normalized;
}

/**
 * Regiões do Brasil por UF — usado no critério "regional".
 */
const UF_TO_REGIAO = {
  AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
  AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste',
  PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
  PR: 'Sul', RS: 'Sul', SC: 'Sul',
};

export function regiaoFromUF(uf) {
  return UF_TO_REGIAO[(uf || '').toUpperCase()] || null;
}

/**
 * Compara o CNAE principal da empresa (e opcionalmente secundários)
 * com a lista de CNAEs compatíveis do produto.
 * Suporta correspondência exata e por prefixo (grupo/divisão),
 * já que CNAEs da mesma família costumam compartilhar os primeiros dígitos.
 */
function scoreCnae(company, product) {
  const productCnaes = (product.cnaesCompatíveis || product.cnaesCompativeis || []).map(String);
  if (productCnaes.length === 0) return 0;

  const companyCnaes = [
    company.cnaePrincipal,
    ...(company.cnaesSecundarios || []),
  ].filter(Boolean).map(String);

  if (companyCnaes.length === 0) return 0;

  let best = 0;
  for (const compCnae of companyCnaes) {
    for (const prodCnae of productCnaes) {
      if (compCnae === prodCnae) {
        // match exato — dá peso maior se for o CNAE principal
        best = Math.max(best, compCnae === String(company.cnaePrincipal) ? 100 : 80);
      } else if (compCnae.slice(0, 4) === prodCnae.slice(0, 4)) {
        // mesma "classe" (4 primeiros dígitos do CNAE)
        best = Math.max(best, 60);
      } else if (compCnae.slice(0, 2) === prodCnae.slice(0, 2)) {
        // mesma "divisão" (2 primeiros dígitos)
        best = Math.max(best, 35);
      }
    }
  }
  return best;
}

function scoreSegmento(company, product) {
  const segmentos = (product.segmentosAtendidos || []).map((s) => s.toLowerCase());
  if (segmentos.length === 0) return 0;
  const alvo = (company.segmento || '').toLowerCase();
  if (!alvo) return 0;
  if (segmentos.includes(alvo)) return 100;
  // correspondência parcial (ex: "varejo alimentar" contém "varejo")
  const parcial = segmentos.some((s) => alvo.includes(s) || s.includes(alvo));
  return parcial ? 55 : 0;
}

function scoreRegional(company, product) {
  const estados = product.estadosPreferenciais || [];
  const regioes = product.regioes || [];
  const uf = (company.estado || '').toUpperCase();
  const regiaoEmpresa = regiaoFromUF(uf);

  if (estados.length === 0 && regioes.length === 0) return 50; // sem restrição = neutro
  if (estados.includes(uf)) return 100;
  if (regiaoEmpresa && regioes.includes(regiaoEmpresa)) return 70;
  return 10; // fora da área preferencial, mas não zera — pode ainda ser vendido
}

function scorePrioridade(product) {
  // prioridade esperada de 1 (baixa) a 5 (alta) no cadastro
  const p = Number(product.prioridade) || 3;
  return Math.min(100, Math.max(0, (p / 5) * 100));
}

function scoreMargem(product, catalogStats) {
  const margem = Number(product.margem) || 0;
  if (!catalogStats.maxMargem) return 0;
  return Math.min(100, (margem / catalogStats.maxMargem) * 100);
}

function scoreRelacionados(product, catalogStats) {
  const qtd = (product.produtosRelacionados || []).length + (product.crossSelling || []).length;
  if (!catalogStats.maxRelacionados) return 0;
  return Math.min(100, (qtd / catalogStats.maxRelacionados) * 100);
}

function computeCatalogStats(products) {
  const margens = products.map((p) => Number(p.margem) || 0);
  const relacionados = products.map(
    (p) => (p.produtosRelacionados || []).length + (p.crossSelling || []).length
  );
  return {
    maxMargem: Math.max(0, ...margens),
    maxRelacionados: Math.max(0, ...relacionados),
  };
}

/**
 * Calcula o score de UM produto para UMA empresa.
 * Retorna { score, breakdown } — breakdown é a rastreabilidade exigida.
 */
export function scoreProduct(company, product, weights, catalogStats) {
  const raw = {
    cnae: scoreCnae(company, product),
    segmento: scoreSegmento(company, product),
    regional: scoreRegional(company, product),
    prioridade: scorePrioridade(product),
    margem: scoreMargem(product, catalogStats),
    relacionados: scoreRelacionados(product, catalogStats),
  };

  const breakdown = {};
  let score = 0;
  for (const key of Object.keys(weights)) {
    const contribution = (raw[key] / 100) * weights[key];
    breakdown[key] = {
      rawScore: Math.round(raw[key]),
      weight: Number(weights[key].toFixed(2)),
      contribution: Number(contribution.toFixed(2)),
    };
    score += contribution;
  }

  return {
    score: Math.round(Math.min(100, Math.max(0, score))),
    breakdown,
  };
}

/**
 * Função principal exportada pelo motor.
 * Recebe a empresa (já normalizada pelo Data Collector) e o catálogo
 * completo de produtos ativos, e devolve o TOP_N pronto para ser
 * enviado à IA — nunca o catálogo inteiro.
 *
 * @param {object} company - empresa retornada/normalizada pelo api.js
 * @param {Array}  allProducts - catálogo completo (status === 'ativo')
 * @param {object} [options]
 * @param {object} [options.weights] - pesos customizados (default: loadWeights())
 * @param {number} [options.topN] - quantidade a repassar à IA (default 20)
 * @returns {{ ranked: Array, topForAI: Array, weights: object }}
 */
export function recommend(company, allProducts, options = {}) {
  const weights = normalizeWeights(options.weights || loadWeights());
  const topN = options.topN || TOP_N_FOR_AI;

  const activeProducts = allProducts.filter((p) => (p.status || 'ativo') === 'ativo');
  const catalogStats = computeCatalogStats(activeProducts);

  const ranked = activeProducts
    .map((product) => {
      const { score, breakdown } = scoreProduct(company, product, weights, catalogStats);
      return { product, score, breakdown };
    })
    .sort((a, b) => b.score - a.score);

  return {
    ranked,
    topForAI: ranked.slice(0, topN),
    weights,
  };
}
