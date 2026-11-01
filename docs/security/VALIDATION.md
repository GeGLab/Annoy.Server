# Validação reproduzível — 31/10/2026

Ambiente final: Linux x64, Node v24.22.2 isolado para reproduzir o runtime Node 24 dos backends, Rust 1.99.1 e Electron real em sessão gráfica. Execuções anteriores usaram Node v26.11.1 e foram preservadas em `evidence/previous-node26/`. Chaves, usuários, mensagens e backups dos testes são sintéticos, em diretórios temporários. Não houve teste Windows nesta máquina nem execução real de SFrame/Cloudflare/mediasoup E2EE.

## Comandos

Organizar os checkouts irmãos `annoy-server`, `annoy-client`, `annoy-api-global`. Instalar dependências com npm ci em cada um; instalar Rust/Cargo. A partir do workspace:

```sh
node annoy-server/scripts/validate-security.mjs /caminho/novo/resultados
```

Antes de reproduzir, `node annoy-server/scripts/verify-security-evidence.mjs` verifica hashes do inventário e logs. Isso verifica integridade do registro, não autenticidade/auditoria.

O runner executa protocolo nativo, typechecks, testes de cofre/serviço, unidades de cliente/assinatura/atividade, todos os testes Server, Global, build do cliente com Rust release e toda a suíte desktop, incluindo dois clientes Electron reais. `ANNOY_REQUIRE_NATIVE=1` impede skips silenciosos dos testes MLS quando o binário falta. Requer DISPLAY gráfico no Linux; o workflow CI prepara Xvfb + dbus-run-session + Openbox no display descartável para testar também maximização. O workflow não foi executado nesta máquina. Testes não publicam ou instalam releases. Resultados JSON incluem exit codes, tempo e SHA-256 dos logs.

Nesta máquina, `annoy-client/tests/display.local.json` contém `{"monitor":"DP-5"}` e é ignorado pelo Git. O launcher aplica uma regra temporária exclusiva da classe de testes, sem roubar foco ou editar configuração pessoal do Hyprland. Ausência do monitor aborta antes de abrir janelas. A execução usa XWayland; Chromium sem janela permanece headless. `evidence/test-display.json` registra uma observação real de janela no DP-5 com foco mantido no HDMI-A-3. Apenas o passo de confirmar maximizar/restaurar é explicitamente não executado nesse modo, pois o compositor não confirma esse estado em janelas flutuantes sem foco; a limitação não afeta código distribuído nem equivale a validação Wayland/Windows. Ver [histórico de validação](VALIDATION-HISTORY.md).

Comandos específicos:

```sh
# annoy-client
cargo test --locked --manifest-path native/annoy-crypto/Cargo.toml
npm run test:crypto
npm run test:updates
npm run test:transport
npm run test:activity
npm run typecheck
npm run build
npx playwright test tests/account-policy.spec.ts tests/crypto-desktop.spec.ts
npx playwright test
npm run crypto:benchmark
cargo audit --file native/annoy-crypto/Cargo.lock
npm audit
# annoy-server
npm run typecheck
npm run test:security
npm audit
# annoy-api-global
npm test
npm audit
# annoy-front-global
npm run build
```

## Execução e evidências

A execução integrada final (01/11/2026, Node v26.11.1, inclui mídia E2EE) passou com **243 testes aprovados**, um teste exclusivo do Windows não executado e o passo de maximização explicitamente não executado no modo isolado descrito acima. Os dez comandos do runner terminaram com exit code zero. `evidence/results.json` registra comandos, plataforma, duração e hashes dos logs finais. O build do frontend Global também passou, registrado separadamente. Execuções anteriores e falhas corrigidas foram preservadas e explicadas em [VALIDATION-HISTORY.md](VALIDATION-HISTORY.md); a execução anterior de 226 casos está em `evidence/previous-validated-226/`. Repetições de testes com o binário empacotado não são somadas novamente. Não transformar resultado de build em validação de segurança.

| Suíte | Resultado local final | Escopo |
|---|---|---|
| Rust OpenMLS | 12 testes aprovados | FS/PCS, autenticidade, replay, remoção, identidade/política/recuperação e quatro casos do grupo MLS de chamada |
| Rust SFrame | 6 testes aprovados | Vetor oficial RFC 9605 C.3 (0x0005), KID, replay, adulteração, épocas, contadores |
| Client crypto | 10 testes aprovados | Cofre, backup, expiração/fila, protector, processo real, domínio de mídia, limpeza de buffers e descarte de chamadas |
| Client unidades selecionadas | 33 testes aprovados | Acesso, atualização/assinatura, transporte, remoção de servidor e volume |
| Client atividade | 27 testes aprovados | Privacidade, autorização IPC, adapters, encerramento após destruição da janela; fixtures Windows não equivalem a runtime Windows |
| Server completo | 81 testes aprovados | Modos, TLS/proxy, autorização, controlador real, migração, sessões e funcionalidades existentes |
| API Global | 16 testes aprovados | Conta, cofre, recuperação, tokens e migração de escrow |
| Desktop Electron + Chromium | 58 aprovados, 1 skip Windows (inclui chamada SFrame via mediasoup e chamada privada P2P cifrada); passo nativo de maximização excluído no modo DP-5 | Inclui 9 casos de integração de segurança: modos, dois clientes MLS com anexos/edições, IPC externo/navegação, cookies, redirects e cancelamento nativo real. Outros casos usam fixtures de UI e não demonstram criptografia |
| Builds/typechecks | Aprovados | Client/Server tipos, Rust release e renderer, frontend Global build |
| Windows | Não executado | Workflow `annoy-client/.github/workflows/security.yml` preparado, não acionado |
| SFU com SFrame | mediasoup real e P2P com dois Electron: aprovados. Cloudflare: não executado com o serviço real | Captura do encaminhado pelo SFU contém só frames SFrame; vídeo decodificado no destino; troca de época ao sair |

Os números devem ser conferidos nos logs finais, não presumidos a partir desta tabela. CI faz checkout dos repositórios irmãos: definir refs contendo as mesmas mudanças antes de interpretar o resultado. `main` ainda não contém necessariamente o trabalho local. Não existe push ou publicação implícita neste workflow.

## Matriz dos 20 cenários obrigatórios

| # | Cenário | Evidência automatizada e limite |
|---|---|---|
| 1 | Vazamento SQLite | `crypto-delivery`, `crypto-controller`, Global: canários privados ausentes das tabelas/ciphertext de entrega; chaves somente cliente. Legado é dataset separado |
| 2 | Servidor self-hosted comprometido | Substituição de groupId, signer/KeyPackage/roster e downgrade recusados; dados de servidor sem chaves. Não é exploração completa de um host real |
| 3 | Global comprometido | Testes Global sem chaves legíveis/escrow; novo dispositivo não entra sem raiz/endosso. Não é pentest de infraestrutura Global |
| 4 | Substituição de chaves públicas | Rust `key_substitution...`, `devices`, pins/raiz e identidade inesperada HTTP |
| 5 | Interceptação/alteração | Rust autenticação/tamper, envelopes assinados, arquivo e backup adulterados |
| 6 | Repetição | Rust replay, idempotência de entrega/outbox e DPoP repetido |
| 7 | Desconexão em renovação | Controlador perde resposta após commit, commits simultâneos, rebase e aplicação em época desatualizada |
| 8 | Chave antiga comprometida | Rust FS/PCS com snapshots separados; não confundir snapshot de protocolo com histórico permanente do cofre |
| 9 | Recuperação após comprometimento | Rust atualização honesta do membro comprometido; clone antigo não abre futuro; reingresso com substituição de dispositivo por mesmo principal |
| 10 | Remoção de grupo | Rust removed member falha mesmo sem receber commit; três controladores HTTP demonstram histórico e autorização futura |
| 11 | Revogação de dispositivo | `devices`, DPoP/WS e controlador: sessões antigas recusadas, novas folhas endossadas, recibo antigo invalida expurgo |
| 12 | Backup antigo | Tokens/provas após restauração isolada, backups sem ratchets/temporários, tombstones no cofre atual e restore legado sem rewind |
| 13 | Exclusão criptográfica | Registros e filas temporárias expiradas ausentes; backup exportado não contém temporário; AEAD/fileKeys locais. Não cobre backup completo antigo do dispositivo |
| 14 | Migração Global/Local | `account-mode-migration`, `account-policy`, Global e Electron; fingerprint, backup, falha fechada e IDs preservados |
| 15 | Global indisponível | Local não faz chamadas Global; modo Global não cai para Local; testes HTTP e Electron |
| 16 | IPC Electron | Duas WebContents e navegação do documento da própria janela com preload não podem desbloquear cofre; prefs sandbox/isolation conferidas |
| 17 | Autorização API | Ownership, social/profile/Steam, blobs/canais, DMs e legado; testes de não membro/IDOR. Revisão de toda API ainda necessária |
| 18 | Logs | Processo Server real com canários em query/header/DPoP/password/body; ausência em stdout/stderr e IP no serializer |
| 19 | Mídia através do SFU | **mediasoup e P2P aprovados** (`tests/voice-e2ee.spec.ts`): SFU encaminha só SFrame, destino decodifica, remoção rotaciona a época. Cloudflare não ensaiado com o serviço real |
| 20 | Downgrade | Modos persistidos, status/groupId pins, suite MLS fixa, API legível 409, bloqueio pré-requisição no cliente e insert por SQLite de cliente antigo negado |

## Orientação ASVS 5.0.0

Referência de versão: [OWASP ASVS 5.0.0](https://asvs.owasp.org/). Esta tabela orienta revisão; não é avaliação integral nem conformidade de nível L1/L2/L3.

| Área ASVS | Aplicação e evidência | Pendência |
|---|---|---|
| V1/V2/V4/V5 | Zod, tamanho, API, arquivos, SSRF/DNS, testes rede/autorizações | Fuzzing amplo, todas as rotas e abuso distribuído |
| [V6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md), 6.1.1/6.3.1/6.3.4 | Política exclusiva, Argon2id, throttle com prefixo real, sem caminho alternativo Discord | Avaliar demais controles de senha, MFA e recuperação conforme nível pretendido |
| [V7](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md), 7.2 e 7.3–7.5 | Token CSPRNG, sessão com validade, binding DPoP, revogação API/WS | Rever limites paralelos, timeout de inatividade e dispositivos reais |
| [V8](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md), 8.2.1/8.2.2/8.3 | Permissões no backend, acesso a recursos e rechecagem após I/O | Pentest completo BOLA/BOPLA e alterações concorrentes |
| V9/V11/V12 | jose, OpenMLS, suite fixa, TLS remoto e chave somente cliente | Auditoria do provider/backport e configuração HTTPS real |
| V3/V13/V14/V15/V16 | Electron/CSP, segredos SO, logs mínimos, backups, fail-closed e processo de build | Instaladores/keychain Windows, dependências e recuperação sob falha real |
| [V17](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x26-V17-WebRTC.md) | Sinalização autenticada e modos explícitos de mídia | SFrame validado com mediasoup e P2P; Cloudflare, TURN e carga não validados |

## Dependências e desempenho

Consultar `evidence/` para auditorias datadas. npm Server/Global sem vulnerabilidades reportadas; cliente registra 15 ocorrências moderadas da cadeia de build minimatch. Cargo audit não reporta vulnerabilidades para 174 crates e registra pacote opcional não mantido; a consulta final atualizou o índice e o advisory DB. Não suprimir avisos ou inferir ausência de risco.

Benchmark sintético de 100 mensagens pequenas entre dois processos locais, com IPC/ratchet/cofre e decriptação; `evidence/benchmark.json` registra p50/p95, total e RSS do main. Exclui rede, grandes grupos, arquivos e RSS nativo. Não prova desempenho aceitável de produção. O teste do cofre com 1000 registros confirma manifesto raiz limitado e alteração de apenas um shard, não um ensaio de carga completo.

O ensaio adicional `evidence/group-capacity.json` cria 256 folhas MLS, mantém somente o coordenador e o último receptor ativos, e troca 100 mensagens pequenas: setup de cerca de 1,45 s, p50 2,67 ms, p95 2,82 ms, snapshot do coordenador 898.213 bytes e pico RSS nativo 7.708 KiB. As outras folhas estão offline. Exclui cofre, IPC, HTTP, Electron, SFU, frames e sincronização de todos os membros; não é uma chamada de 256 participantes nem é comparável diretamente ao benchmark anterior.

A etapa [LINUX-PACKAGE.md](LINUX-PACKAGE.md) verifica o pacote local sem publicação: bundles e 48 arquivos de runtime criptográfico, binário Rust, quatro fuses e ausência de caminhos sensíveis conhecidos. Pacote antigo com fuses padrão e binário adulterado foram recusados. Os dez testes de crypto foram repetidos contra o binário distribuído; GUI/instalação/assinatura de produção continuam sem validação. Windows e auditoria independente foram adiados pelo responsável e não foram considerados aprovados.

Após a execução integrada de 231 casos, a limpeza de buffers foi estendida também à saída tardia de um processo encerrado. Essa guarda foi validada novamente pelos dez testes crypto, pelo build do cliente e pelo caso Electron real com dois clientes. O pacote foi reconstruído e verificado novamente contra esse build, e os dez testes foram repetidos com seu binário Rust. `evidence/follow-up-media.json` registra esses comandos separados e hashes; eles não aumentam a contagem de casos distintos.

Próximos bloqueadores: auditoria independente, Windows real, chave de produção e instalação assinada, ensaio real do Cloudflare Realtime SFU, auditoria do crate sframe e testes de carga/fault injection. Nenhum foi declarado aprovado por ausência de falha nos testes existentes.
