# Smart Seller AI

Aplicação web para consultores comerciais: informe um CNPJ e receba os **5 produtos
com maior probabilidade de venda**, combinando regras de negócio, um motor de score
e um especialista de IA generativa — nessa ordem, nunca ao contrário.

## Por que a IA nunca escolhe sozinha

A IA generativa **não navega o catálogo inteiro**. O `recommendationEngine.js`
(o "coração" do sistema) calcula um score de 0–100 para **todos** os produtos
ativos, usando critérios auditáveis e pesos parametrizáveis. Só os **20 melhores**
são enviados ao `aiEngine.js`, que devolve os 5 finais com a justificativa
comercial. A IA nunca pode inventar produto, alterar nome, ou escolher fora da
lista — isso é reforçado tanto no prompt quanto por sanitização em código
(`sanitizeAIResponse`), que descarta qualquer id que não bata com o que foi
enviado.

Essa separação:
- reduz custo de IA (20 itens em vez de milhares),
- aumenta velocidade (menos tokens),
- aumenta precisão (a IA interpreta, não descobre),
- e dá rastreabilidade: todo score expõe o `breakdown` de quanto cada critério
  (CNAE, segmento, região, prioridade, margem, relacionados) contribuiu.

## Arquitetura

```
Consultor digita CNPJ
        │
        ▼
api.js (Data Collector) ──► BrasilAPI / ReceitaWS (fallback em cadeia, cache, rate limit)
        │  company{ cidade, estado, cnaePrincipal, segmento inferido... }
        ▼
recommendationEngine.js (Smart Recommendation Engine — SEM IA)
   • score(produto) = Σ peso_i × critério_i(company, produto)
   • ordena TODOS os produtos ativos
   • corta para os 20 melhores (topForAI)
        │
        ▼
aiEngine.js (AI Sales Specialist — OpenAI via Firebase Function)
   • recebe só os 20 pré-filtrados + perfil da empresa
   • devolve 5, com motivo/benefício/argumento/objeções
   • sanitizeAIResponse() descarta qualquer item fora da lista original
        │
        ▼
app.js renderiza os cards ──► history.js grava a consulta
                            ──► learningEngine.js registra desfecho (venda/recusa)
                                para, no futuro, sugerir ajustes de peso
```

### Os quatro motores

| Motor | Arquivo | Usa IA? | Responsabilidade |
|---|---|---|---|
| Data Collector | `js/api.js` | não | Consulta e normaliza dados do CNPJ |
| Smart Recommendation Engine | `js/recommendationEngine.js` | não | Score parametrizável de todos os produtos |
| AI Sales Specialist | `js/aiEngine.js` + `functions/openaiProxy.js` | sim | Interpreta e justifica o top 20 → top 5 |
| Learning Engine | `js/learningEngine.js` | não (ainda) | Registra desfechos para ML futuro |

### Estrutura de pastas

```
/smart-seller-ai
  index.html            → tela de consulta (principal)
  dashboard.html         → gráficos (Chart.js)
  products.html          → CRUD administrativo de produtos
  firestore.rules        → segurança por papel (admin/consultor)
  /assets/css/main.css   → design system (dark, glassmorphism leve)
  /js
    app.js                → orquestrador da tela principal
    api.js                → Data Collector
    recommendationEngine.js → Smart Recommendation Engine (coração do sistema)
    aiEngine.js             → AI Sales Specialist (chama o proxy, nunca a OpenAI direto)
    learningEngine.js       → registro para aprendizado futuro
    firebase.js              → inicialização única do Firebase
    auth.js                  → login (Google/Email) + papéis
    products.js               → CRUD + importação Excel/CSV/JSON
    history.js                → histórico de consultas/recomendações
    dashboard.js               → gráficos Chart.js
    utils.js                   → validação de CNPJ, cache, debounce, rate limit
  /data/products.json    → catálogo de exemplo (5 produtos) para rodar sem Firebase
  /functions/openaiProxy.js → Cloud Function que protege a OPENAI_API_KEY
```

### Firestore

```
/users            { uid, nome, email, role: 'admin'|'consultor' }
/products          { nome, categoria, cnaesCompatíveis[], segmentosAtendidos[],
                     estadosPreferenciais[], regioes[], prioridade, margem, status... }
/categories
/history            { empresa{...}, produtosSugeridos[], consultorUid, data, resultados{} }
/recommendations    (cache opcional de recomendações por CNPJ)
/settings           (pesos do score, mapa CNAE→segmento — editável sem alterar código)
/sales              (eventos do Learning Engine: recomendado/vendido/recusado)
/statistics         (agregados pré-calculados para o dashboard, via Functions)
```

## Rodando localmente (sem Firebase, com catálogo de exemplo)

O `index.html` já funciona lendo `data/products.json` diretamente — útil para
testar o motor de recomendação sem configurar nada:

```bash
cd smart-seller-ai
python3 -m http.server 5500
# abra http://localhost:5500
```

Sem Firebase configurado, login e histórico não funcionam, mas a consulta de
CNPJ (via BrasilAPI, real) e o cálculo de score já são 100% funcionais.

## Configurando o restante

1. **Firebase**: crie um projeto, ative Firestore + Authentication (Google e
   Email/Senha), e cole as credenciais em `js/firebase.js`. Publique
   `firestore.rules` com `firebase deploy --only firestore:rules`.
2. **OpenAI**: defina o secret e faça deploy da function:
   ```bash
   firebase functions:secrets:set OPENAI_API_KEY
   firebase deploy --only functions:openaiProxy
   ```
   Ajuste `OPENAI_PROXY_URL` em `js/aiEngine.js` para a URL publicada, e
   `ALLOWED_ORIGINS` em `functions/openaiProxy.js` para seu domínio real do
   GitHub Pages.
3. **GitHub Pages**: publique a pasta `smart-seller-ai` como raiz do Pages —
   é 100% estático, sem build step, sem backend tradicional. A única peça de
   servidor é a Cloud Function do proxy da OpenAI (obrigatória, para não expor
   a API key no front-end).

## Ajustando os pesos do score sem tocar em código

Os pesos padrão (`DEFAULT_WEIGHTS` em `recommendationEngine.js`) podem ser
sobrescritos em runtime via `saveWeights({...})` — hoje persistidos em
`localStorage`, com ponto de extensão claro para migrar para
`/settings` no Firestore quando a tela de administração de pesos for
construída.

## Próximos passos sugeridos (não incluídos nesta primeira entrega)

- Tela de administração de pesos do score (UI sobre `saveWeights`/`loadWeights`).
- Tela de detalhe/edição de produto (`products.html` hoje lista e importa;
  criar/editar individualmente é o próximo passo natural em `products.js`).
- Integração real de "Adicionar ao Pedido" com um módulo de pedidos.
- `suggestWeightAdjustments()` em `learningEngine.js` — hoje é um placeholder
  intencional para quando houver volume de dados de venda suficiente.
