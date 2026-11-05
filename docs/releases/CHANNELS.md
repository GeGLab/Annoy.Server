# Canais de release

Toda versão leva o canal no nome (semver pre-release):

| Canal | Exemplo | Onde sai | Quem recebe |
|---|---|---|---|
| alpha (linha principal) | `0.10.0-alpha.1` | release normal no GitHub (não marcar "pre-release") | imagem `latest` e `alpha`; app no canal alpha |
| beta / estável | `0.11.0-beta.1`, `1.0.0` | release normal | os mesmos: alpha → beta → estável, nunca volta |
| unstable | `0.10.0-unstable.202611041530` | `docker-channel.yml` / `channel-build.yml` (manual) | `ANNOY_VERSION=unstable`; app no canal unstable |
| nightly | `0.10.0-nightly.202611040300` | os mesmos workflows, todo dia 03:00 UTC | `ANNOY_VERSION=nightly`; app no canal nightly |

A linha principal precisa ser release normal: instalações do app até a 0.9.x
procuram atualização só na "latest" do GitHub, que ignora pre-releases. Os
workflows de release recusam uma tag alpha/beta marcada como pre-release e uma
nightly/unstable que não esteja marcada.

## Nightly e unstable (lançados na 0.10.0-alpha.1)

- O app oferece os três canais em Configurações → Atualizações.
- Quem está numa build nightly/unstable e escolhe Alpha vê a recomendação de
  aguardar uma versão estável. "Ir para a versão Alpha agora" pede confirmação
  e só então instala uma versão mais antiga, sempre com assinatura válida e
  respeitando os avisos críticos.
- Assinatura: chave de CI `annoy-channels` (pública em
  `src/main/update-trust.ts`, limitada a nightly/unstable por
  `UPDATE_KEY_CHANNELS`; privada em `~/.config/annoy/update-signing/annoy-channels-2026.pem`
  e no secret `ANNOY_CHANNEL_SIGNING_KEY` do client). A chave de release
  continua só local.
- Nightly: todo dia 03:00 UTC a partir da `main` (pula se a `main` não mudou,
  no client). Unstable: manual, Actions → channel-build → Run workflow,
  escolhendo a branch.
- Pausar tudo: variável `ANNOY_CHANNELS` diferente de `on` (client e server).

Retenção: o workflow do client guarda as 3 últimas builds de cada canal, porque
o updater lê só as 10 entradas mais novas do feed de releases.

## Releases antigas renomeadas (04/11/2026)

Todas as releases até a 0.9.x passaram a ter título `-alpha`. As tags também
viraram `-alpha` (mesmo commit; a tag antiga foi apagada), com duas exceções:

- Client `v0.9.3`: renomeada para `v0.9.3-alpha` em 05/11/2026, depois que a
  `0.10.0-alpha.1` virou a "latest".
- Server `v0.9.0`–`v0.9.4`: releases imutáveis no GitHub, a tag não pode mudar.
  Ficam só com o título `-alpha`. As imagens Docker não mudam.
