# Amigo Secreto

Site de amigo secreto para um grupo de amigos. Qualquer pessoa com o link participa, sem conta em nenhum serviço.

- Cada participante informa **nome, e-mail, sugestões de presente** e cria um **PIN**.
- O organizador define **subgrupos** (escondidos dos participantes). O sorteio acontece **só dentro de cada subgrupo**, para ninguém tirar alguém de fora do próprio círculo.
- O organizador escolhe a **imagem do tema** e **libera o sorteio** quando quiser.
- Depois do sorteio, cada pessoa entra com e-mail e PIN e vê **só o próprio resultado**, com as sugestões de presente de quem tirou.
- O sorteio é feito no servidor e a área do organizador nunca recebe quem tirou quem.

## Arquivos

| Arquivo | Para que serve |
| --- | --- |
| `index.html` | A página inteira (participantes e organizador) |
| `api/app.js` | A API: inscrição, login, sorteio e área do organizador |
| `vercel.json` | Cabeçalhos de segurança da página (CSP e afins) |
| `test/app.test.js` | Testes automatizados da API (`npm test`) |
| `package.json` | Dependência do banco de dados (`@upstash/redis`) |

## Como publicar

### 1. GitHub
Crie um repositório e envie estes arquivos para a raiz dele (`index.html`, `api/`, `package.json`, `README.md`, `.gitignore`).

### 2. Vercel
1. Em [vercel.com](https://vercel.com), clique em **Add New → Project** e importe o repositório.
2. Em **Framework Preset**, deixe **Other**. Não precisa de comando de build.
3. Clique em **Deploy**. A página abrirá, mas ainda sem banco de dados.

### 3. Banco de dados (Redis da Upstash)
1. No projeto da Vercel, abra a aba **Storage** (ou **Marketplace**) e crie um banco **Upstash Redis** no plano gratuito.
2. Conecte o banco a este projeto. Isso cria as variáveis de ambiente do banco automaticamente.
3. Confira em **Settings → Environment Variables** se existem `KV_REST_API_URL` e `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`). O código aceita os dois pares de nomes.

### 4. Senha do organizador
Em **Settings → Environment Variables**, crie a variável `ADMIN_PASSWORD` com a senha que só você vai usar. Escolha uma senha longa.

### 5. Publicar de novo
As variáveis só valem depois de um novo deploy: aba **Deployments**, menu **⋯** do último deploy, **Redeploy**.

## Como usar

1. Abra `https://SEU-PROJETO.vercel.app/#admin` e entre com a senha.
2. Escolha a imagem do tema e salve o nome do evento e o recado.
3. Toque em **Copiar convite com o link** e envie ao grupo.
4. Conforme as pessoas se inscreverem, defina o **subgrupo** de cada uma. Quem ficar sem subgrupo é sorteado com os outros sem subgrupo.
5. Toque em **Liberar sorteio** (e confirme). Depois toque em **Copiar aviso de sorteio liberado** e mande ao grupo.
6. Cada pessoa abre o link, toca em **Já me inscrevi**, entra com e-mail e PIN e revela quem tirou.

## Regras do sorteio

- Ninguém tira a si mesmo e cada pessoa é tirada exatamente uma vez.
- Cada subgrupo precisa ter pelo menos 2 pessoas. Com 2 pessoas, elas tiram uma à outra.
- Com 3 ou mais pessoas no subgrupo, o sorteio forma um ciclo único, sem trocas de par a par.
- Depois do sorteio as inscrições ficam fechadas. Para incluir alguém, use **Reabrir inscrições** e sorteie de novo (os resultados antigos são apagados).

## Privacidade e limites

- PINs são guardados com hash (scrypt) e nunca voltam para a tela. O organizador pode definir um novo PIN para quem esqueceu, mas não vê o antigo. Quem recebe um PIN definido por você passa a ser alguém cujo resultado você poderia abrir, então só use isso quando for necessário.
- O organizador não recebe resultados pela página. Mas quem tem acesso ao painel da Upstash ou da Vercel consegue ler o banco de dados, onde os resultados ficam guardados. Para manter a surpresa, o organizador pode evitar abrir o banco.
- Há limite de tentativas de login por e-mail, por endereço de rede e na senha do organizador. O contador é criado já com expiração, então não fica travado para sempre.
- As inscrições e o sorteio usam uma trava (lock) no banco: dois cliques ou duas abas não geram resultado duplicado nem e-mail repetido.
- O diagnóstico em `/api/app?diag=1` mostra só se as variáveis existem (sim/não), nunca os nomes ou os valores.
- Este projeto não envia e-mails. O aviso de sorteio liberado é um texto para você copiar e enviar ao grupo. Para envio automático seria preciso um serviço de e-mail (como o Resend) e, em geral, um domínio verificado.
- A imagem do tema é reduzida para caber (cerca de 300 KB).
- Fora da Vercel, sem as variáveis do banco e sem `NODE_ENV=production`, a API usa um banco em memória que apaga tudo ao reiniciar. Serve só para testes locais; em produção ela recusa iniciar sem banco configurado.

## Testes

Com Node 18+ rodando na raiz do projeto:

```sh
npm test
```

Os testes usam um banco em memória e cobrem inscrição, login, sorteio, privacidade do organizador e limites.
