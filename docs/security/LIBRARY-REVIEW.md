# Bibliotecas e decisão de integração

Consulta e testes locais em 31/10/2026. Não é uma auditoria das bibliotecas.

| Componente | Seleção | Evidência/limite |
|---|---|---|
| DMs/grupos | OpenMLS 0.9.2, somente MLS RFC 9420 | Auditoria pública SRLabs do projeto; combinação Annoy/provider mais recente fora dessa evidência |
| Provider | Código oficial OpenMLS rev 28369d5b48608bef4ddf8371d91503b0f3852bb3, adapters de manifests/storage registrados | Provenance e diff em vendor; eliminou dependências vulneráveis do lock anterior. Exige revisão independente da combinação |
| AES-GCM/Ed25519/HKDF de aplicação | Node/OpenSSL | Primitivas existentes; formatos/versionamento contextual de aplicação não são auditoria da integração |
| Argon2id Electron | libsodium-wrappers-sumo 0.8.4 | Necessário porque o Electron/BoringSSL real não oferecia Argon2 nativo como o Node de teste; teste contra resultado Node com parâmetros idênticos. Não atribuir auditoria de outra versão ao wrapper atual |
| DPoP | jose 6.2.14 | JWT/JWK padronizados, sem assinatura JWT artesanal; validação de sessão/nonce/claims testada no Annoy |
| Token Global | @cloudflare/blindrsa-ts 0.4.6 | Substitui matemática manual preexistente por implementação RFC 9474. Auditoria independente da integração não demonstrada |
| Mídia | `sframe` 2.1.0 (RustCrypto: aes-gcm, hkdf, sha2), WebAssembly via wasm-bindgen 0.2.130 | Implementa RFC 9605 com derivação MLS §5.2; passa no vetor oficial C.3 da suíte 0x0005 nos testes do Annoy. Sem auditoria pública conhecida |

A pesquisa consultou [Cisco SFrame](https://github.com/cisco/sframe), [sframe-rs](https://github.com/TobTheRock/sframe-rs), a [documentação de E2EE LiveKit](https://docs.livekit.io/transport/encryption/) e o [RFC 9605](https://www.rfc-editor.org/rfc/rfc9605.html). Existência de implementação ou alegação de E2EE não demonstra auditoria aplicável à versão, compatibilidade RFC e integração com os dois SFUs deste projeto. Não foi localizada/validada evidência suficiente para selecionar uma combinação auditada e demonstrar transmissão SFrame segura no Annoy. Isso não afirma que nenhuma biblioteca auditada possa existir; registra o limite da seleção feita.

A avaliação adicional incluiu [libdave](https://github.com/discord/libdave) e a [revisão pública descrita pelo Discord](https://discord.com/blog/bringing-dave-to-all-discord-platforms). Apesar dessa evidência de auditoria, o [payload DAVE](https://daveprotocol.com/#payload-format) usa framing próprio, com footer, tag truncada e marcador `0xFAFA`; não substitui uma implementação RFC 9605 neste requisito. Não integrar MLS++ em lugar do OpenMLS ou apresentar DAVE como SFrame. A base implementada em [MEDIA-KEYS.md](MEDIA-KEYS.md) usa somente o exporter padrão do OpenMLS, sem introduzir biblioteca nova nem construção de cifra de frames.

Decisão de 01/11/2026: sem implementação SFrame auditada e compatível disponível, adotou-se `sframe` 2.1.0 (fork mantido de goto-opensource/secure-frame-rs), que segue a RFC, inclui seus vetores de teste e oferece a derivação MLS. Nenhuma primitiva ou formato próprio foi criado: o adaptador do Annoy só gerencia épocas, KIDs e o transporte das chaves. A ausência de auditoria é risco aberto (RISKS.md) e condição de release.

Não substituir SFrame por insertable streams com uma construção criptográfica caseira, nem por DTLS-SRTP no SFU. O caminho para habilitar exige evidência da biblioteca, bindings/worker, exportação MLS por chamada sem exposição ao servidor, KIDs/contadores únicos, replay, rotação por entrada/saída e ensaios reais em mediasoup/Cloudflare. A atual camada de recusa/consentimento evita uma promessa falsa; ela não implementa esses elementos.

O audit npm do cliente contém avisos moderados de minimatch no empacotamento. Forçar minimatch 11 sobre consumidores que esperam API callable v3 é incompatível; o downgrade de electron-builder sugerido automaticamente não foi aplicado. Não suprimir o resultado. Registrar os locks e reavaliar atualização upstream com testes de instalador antes de release.
