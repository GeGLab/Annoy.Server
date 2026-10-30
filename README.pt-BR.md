<div align="center">

# Annoy Server

**Chat de voz e texto auto-hospedado. Hospede como TeamSpeak, use como Discord.**

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-7b61ff.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-pronto-2496ed?logo=docker&logoColor=white)

[English](README.md) · **Português (Brasil)**

<img src="docs/screenshots/chat-and-voice.png" alt="Annoy: canais de texto, canal de voz com membros conectados e lista de membros com cargos" width="860">

</div>

## Por quê?

O chat da sua comunidade deveria rodar numa máquina sua. O Annoy é um único
processo que você sobe num servidor de casa, numa VPS ou num mini PC. Não
precisa de conta em nuvem, telemetria nem banco de dados externo. Você aponta o
[client desktop](https://github.com/GeGLab/annoy-client) para o
endereço e tem o que todo mundo espera do Discord: servidores, canais, cargos,
voz, DMs e amigos. O Discord oficial fica a um clique no próprio client, então
dá para migrar aos poucos.

## Funcionalidades

| Área | O que tem |
| --- | --- |
| **Texto** | Servidores, categorias, canais, histórico paginado, edição/exclusão, respostas, menções, markdown, anexos e "digitando…" |
| **Voz** | WebRTC com SFU embutido ([mediasoup](https://mediasoup.org)), detecção de voz ou apertar para falar, mute/deafen, quem está falando, silenciar e desconectar membros |
| **Permissões** | Hierarquia de cargos, 15 permissões, permitir/herdar/negar por canal para cargos e membros, convites com validade e limite, expulsar e banir |
| **Social** | Amigos, presença e mensagens diretas |
| **Importar do Discord** | Canais, categorias, cargos, permissões e histórico (com anexos) de um servidor do Discord. Você escolhe o que vem |
| **Entrar com Discord** | OAuth2 oficial que puxa @, nome e foto. Mensagens importadas da pessoa passam a ser dela |
| **Operação** | Um processo, SQLite, uma porta de mídia UDP/TCP, imagem Docker |

## Começando

> **Só quem hospeda faz isso.** Uma pessoa sobe o servidor, uma vez. O resto
> instala apenas o [client](https://github.com/GeGLab/annoy-client)
> e entra com o endereço e um convite, como num servidor TeamSpeak.

```bash
git clone https://github.com/GeGLab/annoy-server.git
cd annoy-server
cp .env.example .env   # defina ANNOY_ANNOUNCED_IP com seu IP público (e o da LAN)
docker compose up -d
```

Troque o IP pelo endereço que os clients usam para chegar na máquina: o da LAN
em casa, ou o público na internet. Libere a porta `8787/tcp` (API) e a `40000`
em **UDP e TCP** (voz).

**Atualização automática (opcional):** coloque `COMPOSE_PROFILES=autoupdate`
no `.env` e rode `docker compose up -d`. Um contêiner `updater` confere a cada
6 horas (`ANNOY_UPDATE_INTERVAL_HOURS`) e reinicia o servidor com a imagem mais
nova de `ANNOY_VERSION`: `latest` segue todas as versões, `0.4` só recebe
correções da 0.4.x. Ele usa o socket do Docker para recriar o contêiner.

**Vindo do Distopic (0.2):** o projeto agora se chama Annoy. As variáveis
mudaram de `DISTOPIC_*` para `ANNOY_*`, mas os nomes antigos continuam
valendo, e os dados ficam no mesmo volume. Aponte o remoto para o novo
repositório e remova o contêiner antigo:

```bash
git remote set-url origin https://github.com/GeGLab/annoy-server.git
git pull && docker compose pull && docker compose up -d --remove-orphans
```

Sem Docker (Node.js 22.13 ou mais novo):

```bash
npm install
npm start
```

## Configuração

Tudo é por variável de ambiente; veja [`.env.example`](.env.example) e a
[tabela completa no README em inglês](README.md#configuration). As principais:

- `ANNOY_ANNOUNCED_IP`: o IP anunciado para a voz. Obrigatório no Docker.
- `ANNOY_REGISTRATION=closed`: bloqueia novos cadastros.
- `ANNOY_DISCORD_CLIENT_ID` e `ANNOY_DISCORD_CLIENT_SECRET`: habilitam o
  "Entrar com Discord".
- `ANNOY_DATA_DIR`: onde ficam o banco, os anexos e as fotos de perfil. É a pasta do backup.
- `ANNOY_PUBLIC_URL`: endereço externo da instância; configure ao usar um proxy.


Para expor na internet, coloque um proxy com TLS (Caddy, nginx, Cloudflare
Tunnel) na frente da porta 8787.

Fotos de perfil agora podem ser enviadas, recortadas e removidas pelo cliente.
Após atualizar as dependências com `npm ci`, reinicie o servidor. As rotas e o
suporte a busca em áudio/vídeo estão em [perfil e mídia](docs/profile-media.md).
Validação local: `npm run typecheck` e `npm run test:profile`.

A busca de mensagens usa um índice local com verificação de permissões.
Atividades de jogos/música são efêmeras e compartilhadas somente entre amigos
confirmados. Veja [busca e atividades](docs/search-activity.md); valide com
`npm run test:discovery` antes de publicar a atualização.

## Integração com o Discord

As duas integrações usam só APIs oficiais do Discord; sua sessão pessoal nunca é
usada.

**Importar um servidor:** crie uma aplicação no
[portal de desenvolvedores](https://discord.com/developers/applications). Na aba
**Bot**, ative **Message Content Intent** e copie o token. No client, vá em
**+ → Importar do Discord** e siga o assistente: adicione o bot com o link
gerado, escolha o servidor e marque canais, histórico, cargos e opções. Os
autores viram perfis importados (nome e foto, sem login). Membros, DMs, fóruns,
threads, emojis e figurinhas não são importados, e o token nunca é salvo.

**Entrar com Discord:** na mesma aplicação, em **OAuth2 → Redirects**, adicione
`https://seu.dominio/api/auth/discord/callback` e defina as variáveis
`ANNOY_DISCORD_CLIENT_ID` e `ANNOY_DISCORD_CLIENT_SECRET`.

**Steam:** o cliente detecta jogos localmente no Windows e Linux, incluindo Proton.
Em **Configurações → Atividade**, também é possível vincular uma conta pelo login
oficial da Steam. A vinculação não exige chave; para consultar o jogo online
quando não houver jogo local, configure `ANNOY_STEAM_API_KEY` no servidor.
Veja [configuração e privacidade](docs/steam.md).

## Licença

[MIT](LICENSE) © Gustavo Cruz.

## Desconexões a partir da 0.8

Voz, vídeo, tela e chamadas privadas encerram quando o cliente perde a
instância, inclusive em atualizações. O servidor remove a sessão sem período
de tolerância e tenta revogar as faixas no Cloudflare durante um encerramento
normal. A API volta automaticamente; voltar à voz exige entrar no canal de
novo. Atualize os clientes para 0.8.0 para que também parem as capturas numa
queda abrupta. Veja [a versão 0.8.0](docs/releases/0.8.0.md).
