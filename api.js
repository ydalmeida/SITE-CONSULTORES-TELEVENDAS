/**
 * api.js — DATA COLLECTOR
 * ------------------------------------------------------------------
 * Responsável por consultar o CNPJ e normalizar os dados vindos de
 * diferentes provedores (BrasilAPI, ReceitaWS...) em um único
 * formato ("company") consumido pelo resto do sistema.
 *
 * Estratégia: tenta o provedor primário; em caso de falha/timeout,
 * cai para o próximo (fallback em cadeia). Usa cache (utils.js) para
 * não bater na API repetidamente para o mesmo CNPJ.
 * ------------------------------------------------------------------
 */

import { onlyDigits, isValidCNPJ, cacheGet, cacheSet, createRateLimiter } from './utils.js';

const rateLimiter = createRateLimiter({ maxCalls: 15, windowMs: 60_000 });

/**
 * Provedores, em ordem de tentativa. Cada `parse` normaliza a
 * resposta do provedor para o formato interno padrão da aplicação.
 * Adicionar um novo provedor = adicionar um item nesta lista.
 */
const PROVIDERS = [
  {
    name: 'brasilapi',
    url: (cnpj) => `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
    parse: (data) => ({
      cnpj: data.cnpj,
      razaoSocial: data.razao_social,
      nomeFantasia: data.nome_fantasia || data.razao_social,
      cidade: data.municipio,
      estado: data.uf,
      cep: data.cep,
      cnaePrincipal: String(data.cnae_fiscal ?? ''),
      cnaeDescricao: data.cnae_fiscal_descricao,
      cnaesSecundarios: (data.cnaes_secundarios || []).map((c) => String(c.codigo)),
      naturezaJuridica: data.natureza_juridica,
      porte: data.porte,
      situacao: data.descricao_situacao_cadastral,
      capitalSocial: data.capital_social,
      dataAbertura: data.data_inicio_atividade,
    }),
  },
  {
    name: 'receitaws',
    // ReceitaWS costuma exigir proxy por CORS em produção — mantido
    // como fallback documentado; ajuste a URL para seu proxy/Functions.
    url: (cnpj) => `https://www.receitaws.com.br/v1/cnpj/${cnpj}`,
    parse: (data) => ({
      cnpj: data.cnpj,
      razaoSocial: data.nome,
      nomeFantasia: data.fantasia || data.nome,
      cidade: data.municipio,
      estado: data.uf,
      cep: data.cep,
      cnaePrincipal: String(data.atividade_principal?.[0]?.code || '').replace(/\D/g, ''),
      cnaeDescricao: data.atividade_principal?.[0]?.text,
      cnaesSecundarios: (data.atividades_secundarias || []).map((c) => (c.code || '').replace(/\D/g, '')),
      naturezaJuridica: data.natureza_juridica,
      porte: data.porte,
      situacao: data.situacao,
      capitalSocial: data.capital_social,
      dataAbertura: data.abertura,
    }),
  },
];

/**
 * Mapeia CNAE -> segmento comercial de alto nível usado pelo motor
 * de recomendação. Em produção isso deve virar uma coleção no
 * Firestore (/settings/cnaeSegmentMap) editável pelo admin, sem
 * precisar alterar código — aqui está uma tabela inicial de exemplo.
 */
const CNAE_PREFIX_TO_SEGMENTO = [
  { prefix: '47', segmento: 'Varejo' },
  { prefix: '46', segmento: 'Atacado' },
  { prefix: '56', segmento: 'Alimentação e Bebidas' },
  { prefix: '10', segmento: 'Indústria Alimentícia' },
  { prefix: '41', segmento: 'Construção Civil' },
  { prefix: '43', segmento: 'Construção Civil' },
  { prefix: '86', segmento: 'Saúde' },
  { prefix: '85', segmento: 'Educação' },
  { prefix: '62', segmento: 'Tecnologia' },
  { prefix: '63', segmento: 'Tecnologia' },
  { prefix: '68', segmento: 'Imobiliário' },
  { prefix: '77', segmento: 'Locação e Serviços' },
];

function inferSegmento(cnaePrincipal) {
  const c = String(cnaePrincipal || '');
  const match = CNAE_PREFIX_TO_SEGMENTO.find((m) => c.startsWith(m.prefix));
  return match ? match.segmento : 'Geral';
}

async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Consulta um CNPJ, tentando os provedores em ordem, com cache e
 * proteção contra chamadas excessivas.
 * @param {string} cnpjInput
 * @returns {Promise<object>} company normalizado
 */
export async function fetchCompanyByCNPJ(cnpjInput) {
  const cnpj = onlyDigits(cnpjInput);

  if (!isValidCNPJ(cnpj)) {
    const err = new Error('CNPJ inválido. Verifique os dígitos informados.');
    err.code = 'INVALID_CNPJ';
    throw err;
  }

  const cacheKey = `cnpj:${cnpj}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (!rateLimiter()) {
    const err = new Error('Muitas consultas em pouco tempo. Aguarde alguns segundos e tente novamente.');
    err.code = 'RATE_LIMITED';
    throw err;
  }

  let lastError;
  for (const provider of PROVIDERS) {
    try {
      const res = await fetchWithTimeout(provider.url(cnpj));
      if (!res.ok) throw new Error(`${provider.name} respondeu ${res.status}`);
      const data = await res.json();
      const company = provider.parse(data);
      company.segmento = inferSegmento(company.cnaePrincipal);
      company.fonte = provider.name;

      cacheSet(cacheKey, company, 30 * 60 * 1000); // 30 min
      return company;
    } catch (e) {
      lastError = e;
      // tenta o próximo provedor da cadeia
    }
  }

  const err = new Error('Não foi possível consultar este CNPJ em nenhum provedor disponível.');
  err.code = 'PROVIDER_FAILURE';
  err.cause = lastError;
  throw err;
}
