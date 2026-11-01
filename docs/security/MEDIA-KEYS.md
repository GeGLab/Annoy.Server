# Mídia E2EE: SFrame com chaves MLS por chamada

Implementado e testado em 01/11/2026 em Linux e numa VM Windows 11. Cobre canais de voz nos dois backends (mediasoup e Cloudflare Realtime SFU, ambos ensaiados com dois clientes Electron reais) e chamadas privadas P2P. **Sem auditoria independente**. `mediaProtection` passa a anunciar `{e2ee:true, protocol:'SFrame-RFC9605/MLS-RFC9420', scope:['voice','direct_calls'], status:'unaudited'}`.

## Componentes

| Parte | Onde | Função |
|---|---|---|
| Grupo MLS da chamada | `annoy-client/native/annoy-crypto` (OpenMLS 0.9.2), domínio `media` | Um grupo `annoy/media/v1/INSTANCIA/CHAMADA` por chamada, cada dispositivo uma folha com signer próprio. `media_commit` reúne entradas e saídas pendentes num commit; `media_accept` aplica commits de qualquer membro. Sem política de proprietário: a chamada continua quando quem a criou sai. Operações de conversa (`add`, `remove`, `commit`) recusam grupos de mídia. |
| Vínculo do dispositivo | `annoy-client/src/main/crypto/media-calls.ts` | O processo main assina com a chave Ed25519 do dispositivo `['annoy/media/bind/v1', instância, canal, chamada, usuário, dispositivo, chave MLS da chamada]`. Cada membro verifica cada vínculo contra o próprio diretório fixado (cadeia de certificados, revogação). Folha sem vínculo válido nunca é admitida; commit que acrescente folha não verificada é recusado (`untrusted_addition`). |
| Delivery service | `annoy-server/src/media-e2ee.ts` | Só ordena: guarda o ID da chamada, a época e a lista de membros; repassa KeyPackages, commits e Welcomes; aceita um commit por época (`media_epoch_conflict` para os demais); designa o membro mais antigo como committer e passa a vez após 8 s sem resposta. Não possui chaves. |
| Frames | `annoy-client/native/annoy-sframe` (crate `sframe` 2.1.0, backend RustCrypto) compilado para WebAssembly; `src/renderer/src/media-e2ee/sframe-worker.ts` | Encoded transforms (`RTCRtpScriptTransform`, com fallback `createEncodedStreams`) cifram cada frame enviado e abrem cada frame recebido dentro do worker. Sem chave, o frame é descartado; nunca segue em claro. |

Build: `npm run crypto:build` exige o target `wasm32-unknown-unknown` e `wasm-bindgen-cli` 0.2.130 (`cargo install wasm-bindgen-cli --version =0.2.130 --locked`); o `.wasm` gerado vai para `src/renderer/src/media-e2ee/generated/` (ignorado pelo Git) e é empacotado pelo Vite.

## Derivação e formato

A chave base de cada época é `MLS-Exporter("SFrame 1.0 Base Key", "", 32)` ([RFC 9605 §5.2](https://www.rfc-editor.org/rfc/rfc9605.html#section-5.2)), exportada pelo OpenMLS somente depois de o serviço de voz sequenciar o commit daquela época. Suíte SFrame `0x0005` (AES_256_GCM_SHA512_128). KID = `contexto << 24 | índice da folha << 8 | época mod 256` (E = 8, S = 16). Contextos: microfone 0, câmera 1, tela 2, áudio da tela 3. Os contadores ficam no módulo WebAssembly durante toda a chamada; parar e reiniciar uma transmissão continua o contador do mesmo KID, sem repetir nonce. Cada nova entrada em chamada cria um grupo e chaves novos.

Receptores aceitam até três épocas (as anteriores por 10 s, para quem ainda processa o commit), com proteção contra replay por KID (janela de 128 frames) e limite de 4096 chaves derivadas. Uma época com os mesmos 8 bits baixos substitui a antiga, como exige a RFC.

Em vídeo, o quadro VP8 mantém legíveis os 3 primeiros bytes (10 em quadros-chave), autenticados como *metadata* SFrame (RFC 9605 §4.4). Os empacotadores do Chromium e do SFU precisam desse cabeçalho; ele revela tipo de quadro e dimensões, não o conteúdo. Com E2EE o vídeo é forçado a VP8 (o H264 do roteador não é negociado). Áudio Opus é cifrado inteiro.

## Fluxo

1. O cliente entra com `protection:'sframe'`. Uma sala só tem um modo enquanto houver alguém nela: cliente legado ou sem E2EE recebe `media_protection_mismatch`. O modo transporte exige consentimento explícito, como antes.
2. O primeiro dispositivo cria o grupo (`mediaCreate`); os seguintes publicam KeyPackage e vínculo (`mediaPropose`).
3. O committer verifica os vínculos, gera um commit e um Welcome (`mediaCommit`) e só exporta a nova chave depois do aceite do servidor; uma recusa faz rollback do estado nativo.
4. Saída, expulsão ou perda de permissão gera proposta de remoção; o commit seguinte troca a época. O dispositivo removido recebe `removed_from_call` e descarta o motor.
5. Ao sair, o registro `protocol:media:*` é apagado do cofre; registros deixados por queda do processo são apagados antes da próxima chamada.

As chaves de época chegam ao worker por um `MessagePort` criado no main (`MessageChannelMain`); não passam como valor de retorno IPC nem ficam no estado da página. O preload não expõe comando de exportação.

## Testes

| Teste | Verifica |
|---|---|
| `annoy-sframe/tests/session.rs` (6) | Vetor oficial da RFC 9605 C.3 para a suíte 0x0005; ida e volta entre membros; layout do KID; replay, adulteração de metadata e de ciphertext, época desconhecida, chave errada; ausência de saída sem chave; contadores únicos; retenção e descarte de épocas; troca por bits baixos iguais |
| `annoy-crypto/tests/media.rs` (4) | Exporter igual entre membros e isolado por chamada/instância/domínio; remoção e PCS após atualização honesta; chamada que continua após a saída do criador; adição não verificada recusada; commits concorrentes; snapshots |
| `scripts/tests/mls-service.test.mjs` | Rollback de commit recusado, chave só após aceite, nada de chave no outbox/backup, descarte completo |
| `tests/media-e2ee.test.ts`, `tests/disconnect.test.ts` (servidor) | Sequenciamento, conflito de época, vínculo de outro usuário recusado, modos que não se misturam, saída do criador, reinício da chamada, troca de committer; chamada privada cifrada não aceita atendimento sem E2EE |
| `tests/voice-e2ee.spec.ts` (dois Electron reais) | Canal de voz via **mediasoup real**: centenas de frames cifrados/decifrados nos dois sentidos, zero rejeições, vídeo decodificado no destino, captura do que o SFU encaminha (DirectTransport) contendo somente cabeçalhos SFrame com KID coerente (contexto, folha, época) e contadores crescentes; saída troca a época e o roster. Chamada privada P2P cifrada nos dois sentidos com vídeo exibido |

Os testes usam dispositivos falsos do Chromium, `--mute-audio` e `setAudioMuted`; janelas somente no DP-5.

## Limites

- **Cloudflare Realtime SFU**: ensaiado com o serviço real (dois Electron, frames autenticados nos dois sentidos, vídeo exibido, troca de época). Não há captura do lado da Cloudflare: a prova é que os frames só abrem com a chave dos membros e chegam íntegros. Um aviso já existente de reassinatura de faixa ("Serviço de mídia recusou a faixa") apareceu em 2 de 3 rodadas sem afetar o teste.
- `sframe` 2.1.0 implementa a RFC 9605 e passa no vetor oficial, mas **não tem auditoria pública conhecida**; nenhuma implementação SFrame auditada e compatível com RFC 9605 foi encontrada (DAVE/libdave tem formato próprio). Revisão independente do crate e do adaptador é condição de release.
- As chaves de mídia existem no worker do renderer durante a chamada. XSS no documento confiável pode obtê-las; o mesmo vale para mensagens exibidas.
- SFrame não autentica o emissor individualmente: qualquer membro conhece a chave base da época e pode forjar frames de outro membro.
- Entre a saída de alguém e o commit de remoção, o dispositivo que saiu ainda conhece a época corrente; o SFU deixa de encaminhar para ele imediatamente, mas um servidor malicioso poderia continuar encaminhando nesse intervalo.
- Um servidor malicioso pode negar serviço (não repassar commits, recusar entradas) e vê metadados: quem está na chamada, quando, tamanho e ritmo dos frames, tipo e dimensões do vídeo.
- A primeira identidade de cada usuário continua TOFU (ver modelo de ameaças); a verificação do código de segurança fora de banda é o que fecha a substituição inicial.
- Chamadas com até 256 dispositivos; desempenho em grupos grandes e redes reais não medido. Windows não executado.
- Uma cópia completa antiga do dispositivo tirada durante a chamada pode conter a chave daquela época.
