# Smart Seller AI

Aplicação web para consultores comerciais: informe um CNPJ e receba uma
recomendação inteligente dos 5 produtos com maior probabilidade de venda
para aquele cliente — usando uma arquitetura híbrida de **regras de
negócio + score + IA generativa**.

## Arquitetura (4 motores independentes)

```
CNPJ digitado
   │
   ▼
┌─────────────────────┐   BrasilAPI (pública, sem chave)
│ 1. Data Collector    │──────────────────────────────────
│    js/api.js         │   Razão social, CNAE, cidade, UF,
└─────────┬────────────┘   porte, situação, capital social…
          ▼
┌─────────────────────────────┐
│ 2. Smart Recommendation     │  Calcula um score (0–100) para
│    Engine                   │  TODOS os produtos do catálogo,
│    js/recommendationEngine.js│  usando regras + pesos configuráveis.
└─────────┬────────────────────┘  Devolve só os 20 melhores.
          ▼
┌─────────────────────────────┐
│ 3. AI Sales Specialist       │  Recebe SÓ os 20 pré-selecionados
│    js/aiEngine.js            │  (nunca o catálogo inteiro), escolhe
└─────────┬────────────────────┘  e justifica os 5 melhores.
          ▼
┌─────────────────────────────┐
│ 4. Learning Engine            │  Registra vendido/recusado por
│    js/learningEngine.js       │  produto, cliente, cidade, consultor —
└────────────────────────────── ┘  pronto para futura substituição por ML.
```

A IA **nunca** escolhe produtos entre milhares — ela só interpreta,
justifica e reordena os top-20 que o motor de regras já filtrou. Isso
reduz custo de IA, aumenta velocidade e evita recomendações fora do
catálogo (a resposta da IA é sempre validada contra a lista original;
qualquer ID que não esteja nos 20 é descartado).

## Estrutura do projeto

```
/smart-seller-ai
  /index.html
  /assets/css/style.css
  /js
    app.js                 — controlador de UI / orquestração
    api.js                 — Data Collector (consulta CNPJ)
    recommendationEngine.js— Smart Recommendation Engine (o coração do sistema)
    aiEngine.js             — AI Sales Specialist (+ fallback determinístico)
    learningEngine.js       — Learning Engine
    products.js             — CRUD do catálogo (localStorage)
    history.js               — histórico de consultas
    dashboard.js             — gráficos (Chart.js)
    auth.js                  — sessão do consultor (ver nota abaixo)
    utils.js                  — funções puras compartilhadas
  /data/products.json       — catálogo semente (18 produtos de exemplo)
  /functions/openaiProxy.js — proxy opcional para não expor a chave de IA
  README.md
```

Zero build step: é só HTML + ES Modules + CSS. Funciona 100% em
GitHub Pages (ou qualquer hospedagem estática) sem backend obrigatório.

## Rodando localmente

Como o `index.html` usa `<script type="module">` e `fetch('./data/...')`,
o navegador exige um servidor HTTP (não abre com `file://`). Qualquer um
serve:

```bash
cd smart-seller-ai
python3 -m http.server 8080
# ou: npx serve .
```

Abra `http://localhost:8080`.

## O motor de recomendação (pesos parametrizáveis)

Pesos padrão (ajustáveis em **Configurações**, sem alterar código):

| Critério                    | Peso |
|------------------------------|------|
| Compatibilidade de CNAE       | 40%  |
| Compatibilidade de Segmento   | 25%  |
| Compatibilidade Regional      | 15%  |
| Prioridade Comercial          | 10%  |
| Margem                        | 5%   |
| Produtos Relacionados         | 5%   |

Cada card de recomendação tem uma seção **"Rastreabilidade do score"**
mostrando exatamente quanto cada critério contribuiu para a nota final —
requisito explícito do briefing.

## IA generativa

Por padrão, sem nenhuma chave configurada, o app já funciona de ponta a
ponta usando um **gerador local por regras** (`gerarViaRegras` em
`aiEngine.js`) — ele usa os mesmos critérios/score do motor para escrever
motivo, benefício, argumento de venda, objeções e abordagem sugerida. Isso
significa que a aplicação é utilizável imediatamente, sem custo de API.

Para plugar um modelo de verdade (ex.: GPT), vá em **Configurações → IA
Sales Specialist** e informe:
- **Endpoint**: idealmente a URL do proxy em `functions/openaiProxy.js`
  (a chave fica no servidor, nunca no navegador do consultor);
- ou, para testes rápidos, o endpoint da OpenAI direto + sua chave (não
  recomendado em produção, pois expõe a chave no client-side).

## Sobre login/Firebase

O briefing pede Firebase Authentication (Google + e-mail/senha) com
permissões de Administrador/Consultor. `js/auth.js` implementa a mesma
interface (`login`, `logout`, `isAdmin`, `getUsuarioAtual`) mas com uma
sessão local (localStorage), porque uma integração Firebase real exige as
credenciais do projeto do cliente. O arquivo tem, comentado, exatamente
como trocar a implementação por Firebase Auth + Firestore sem precisar
mexer em nenhum outro módulo — a interface pública não muda.

O mesmo raciocínio vale para o banco: hoje tudo (produtos, histórico,
feedback, configurações) fica em `localStorage`, mas cada módulo
(`products.js`, `history.js`, `learningEngine.js`) já isola toda leitura/
escrita em poucas funções — trocar por Firestore é reescrever só essas
funções internas.

## Importação de produtos

Em **Produtos → Importar**, aceita `.json` (array de objetos no formato
de `data/products.json`), `.csv` (cabeçalho na primeira linha) e `.xlsx`
(primeira aba, cabeçalho na primeira linha) — os nomes de campo aceitam
tanto `camelCase` (`cnaesCompativeis`) quanto `snake_case`
(`cnaes_compativeis`). Listas (segmentos, CNAEs, estados, relacionados)
podem vir separadas por `;` ou `|` dentro da célula.

## Segurança implementada

- Validação de CNPJ (dígitos verificadores) antes de qualquer consulta;
- todo texto vindo de fora (nome de empresa, produto etc.) passa por
  `escapeHtml()` antes de ir para o DOM — sem `innerHTML` de dado cru;
- a resposta da IA é sempre validada contra a lista de produtos que
  realmente existem no catálogo antes de ser exibida;
- chave de IA, quando usada direto (sem proxy), fica só no
  `localStorage` do navegador do próprio consultor — nunca é enviada a
  nenhum lugar além do endpoint configurado.

## Próximos passos sugeridos

- Trocar `auth.js`/`products.js`/`history.js`/`learningEngine.js` por
  Firebase (Authentication + Firestore) quando houver um projeto Firebase
  dedicado — as interfaces já estão prontas para isso;
- usar os dados do Learning Engine para treinar um modelo simples
  (ex.: regressão logística) que substitua gradualmente os pesos manuais
  do motor de regras, como previsto no briefing original.
