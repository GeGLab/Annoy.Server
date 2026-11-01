# Arquitetura criptográfica implementada

## Protocolos e dependências

Somente [OpenMLS / RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) para DMs e grupos; cada dispositivo é uma folha. Não há libsignal ou Double Ratchet separado. Core registry OpenMLS **0.9.2**, traits/storage **0.6**, Cargo.lock fixado. Suite aceita: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. HKDF, nonces, ratchets e assinaturas de protocolo pertencem à implementação MLS; a suite padrão usa AES-128-GCM, não AES-256-GCM.

O [relatório público SRLabs](https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf) e a [publicação dos mantenedores](https://blog.phnx.im/openmls-independent-security-audit/) estabelecem uma auditoria do OpenMLS. Eles não auditam Annoy, bindings, armazenamento, políticas ou este provider mais novo. Provider RustCrypto e basic credential usam código oficial do commit `28369d5b48608bef4ddf8371d91503b0f3852bb3`; manifests foram concretizados e três helpers de storage mantêm API síncrona. Provenance, hashes, licença e diff estão em `annoy-client/native/annoy-crypto/vendor/`. Nenhuma primitiva criptográfica foi criada pelo Annoy. Revisar esse backport antes de release.

Outras bibliotecas: `jose 6.2.14` para DPoP/JWT, Node/OpenSSL para Ed25519/AES-GCM/HKDF, `libsodium-wrappers-sumo 0.8.4` para Argon2id no Electron, `@cloudflare/blindrsa-ts 0.4.6` para o protocolo Global RFC 9474. Não atribuir auditoria independente a essas integrações apenas por usarem protocolos reconhecidos.

## Separação de chaves

| Chave | Origem/uso | Persistência |
|---|---|---|
| Identidade Global | Cliente, admissão com identidade independente por instância | Cofre Global cifrado, sem acesso automático às chaves MLS |
| Raiz de recuperação de identidade da instância | Ed25519 no Electron main | Cofre local e backup permanente controlado pelo usuário |
| Assinatura de dispositivo | Ed25519 exclusiva por dispositivo/instância; endossos/envelopes/DPoP | Cofre local, não exportada como sessão reutilizável |
| Folha MLS | Signer próprio no processo Rust, separado da assinatura de dispositivo | Snapshot secreto no cofre; nunca em backups exportáveis |
| Época/mensagem MLS | OpenMLS | Estado corrente; épocas antigas não retidas; janela de mensagens fora de ordem limitada |
| Arquivo | 256 bits aleatórios por objeto | Manifesto cifrado dentro de mensagem MLS e cópia permanente local enquanto retida |
| Registro/shard do cofre | Chaves aleatórias por registro e shard, AES-256-GCM | Índice cifrado; rotação ao substituir registros/shards |
| Raiz do cofre | Aleatória, protegida pelo SO ou senha Argon2id explícita | Keychain/DPAPI/libsecret ou envelope cifrado; nenhuma alternativa legível |
| Backup | 256 bits aleatórios controlados pelo usuário | Somente chave apresentada nativamente ao usuário; não enviada ao backend |

## Identidade e admissão

Registro exige assinatura de posse e desafio de uso único vinculado à sessão. Primeiro dispositivo estabelece uma raiz TOFU; demais exigem endosso de dispositivo confiável ou raiz de recuperação. Certificados e pins validam cadeias e impedem ressurreição silenciosa de dispositivo revogado. Código de segurança pode ser comparado manualmente; QR não foi implementado porque o código é a alternativa suportada.

Cliente confere origem, instanceId, userId esperado e binding da sessão antes de usar chaves. HTTP remoto é recusado no renderer e no main antes de enviar credenciais; o gateway exige WSS. Redirecionamentos de API não são seguidos. Loopback explícito é a exceção de desenvolvimento. DPoP assina método, URL, hash do token, jti, iat e nonce do servidor. Nonce novo a cada processo impede reutilizar provas após restaurar só o banco. Revogação invalida sessões HTTP/WS e KeyPackages; novos envios dependem de renovação do grupo.

No Electron, autenticação e controlador criptográfico usam `Session.fetch` em partição nativa somente em memória, separada das páginas e serviços, sem cache ou cookies e sem protocolos personalizados. O transporte mantém validação HTTPS e `redirect: error`. A integração testa cookies plantados, redirecionamentos e cancelamento de respostas pendentes; não depende de `Response.url`/`Response.type`, cujas limitações são documentadas pelo Electron. Backend e testes Node continuam usando seu transporte Node padrão.

## Grupos e entrega

Envelope `annoy/mls/envelope/v1` assina instância, canal, grupo, ID, remetente, tipo, época, alvo, validade, roster, blobIds e hash do wire. Conteúdo é MLS PrivateMessage; KeyPackage assinado de uso único e Welcome direcionado permitem recepção assíncrona. Server entrega ciphertext, não executa o protocolo nem possui seus segredos.

Política MLS autenticada via GroupContext extension privada `0xff00` e RequiredCapabilities: versão, proprietário criptográfico e histórico. Somente proprietário admite novos usuários, remove outros e transfere a propriedade. Dispositivo do mesmo usuário requer endosso; recuperação pode substituir apenas folhas do mesmo principal, removendo as revogadas no mesmo commit. Administração de canais e propriedade criptográfica são permissões distintas.

Padrão `since_join`: novos participantes não recebem histórico anterior. `share_permanent`: cliente do proprietário pode encaminhar cópias permanentes, sem segredos de épocas antigas. Cópias declaram `sharedBy`; autoria antiga é uma declaração do compartilhador, não uma assinatura retrospectiva. Mensagens temporárias não são encaminhadas. Canais públicos continuam exigindo admissão/autorizações; nunca existe chave pública universal ou chave do administrador.

Estado e outbox são cifrados antes de retornar ciphertext. IDs idempotentes, cursor, comparação de épocas e checkpoints tratam perda de resposta e commits concorrentes. Ratchets não são reiniciados a partir de backups de usuário. Limites atuais: 256 dispositivos/grupo, plaintext MLS 64 KiB, wire 1 MiB, mensagens fora de ordem 128 e distância futura 1024, nenhuma época passada retida. Atualização ao enviar após 32 mensagens/15 minutos, além de mudanças de membros. Não equivale a rotação periódica de conversas completamente inativas.

## Arquivos, histórico e backup

Anexo usa AES-256-GCM nativo com chave aleatória 32 bytes e nonce aleatório 12 bytes; versão e AAD contextual são autenticadas. Nomes, MIME, texto e fileKey ficam dentro do MLS. Blob do servidor contém apenas ciphertext e tamanho; previews são abertos no cliente com Blob URLs revogáveis. Não há algoritmo de streaming próprio: arquivos inteiros são limitados, com memória limitada pelo IPC.

Cofre v2: registros cifrados individualmente, 256 shards de chaves e manifesto raiz cifrado sob chave HKDF derivada com salt novo em cada gravação. Arquivos novos são sincronizados antes da troca atômica do manifesto. Falha de durabilidade após rename bloqueia o cofre em vez de apagar arquivos que podem estar referenciados. Unlock valida e migra formato v1. Buffers são zerados quando possível, sem garantia de limpar strings/cópias do JavaScript, kernel ou OpenMLS inteiro.

Busca é local, sem enviar a consulta para indexação do conteúdo E2EE. Backup v1 limitado a 40 MiB de dados; v2 em diretório até 64 GiB/100 mil registros, 64 MiB por registro. Manifesto cifrado autentica chaves, IDs e hashes. Restauração valida tudo antes de aplicar, processa tombstones primeiro e preserva registros atuais/pins. Falha de disco durante aplicação por registros pode exigir repetir a importação idempotente. Estados de protocolo, dispositivos e temporários são excluídos.

Temporários: descarte de chaves de registros, filas vencidas, Blob URLs e remoção de blobs do servidor. Não se promete apagar capturas, chaves em backups completos do SO ou estados antigos copiados pelo adversário. Histórico permanente não expira automaticamente.

## Mídia

[SFrame RFC 9605](https://www.rfc-editor.org/rfc/rfc9605.html) via crate `sframe` 2.1.0 em WebAssembly, chave base pelo exporter OpenMLS de um grupo por chamada (§5.2), suíte 0x0005. O servidor só sequencia commits. Vínculos de dispositivo assinados e verificados no diretório fixado. DTLS-SRTP com SFU não é tratado como E2EE; o modo transporte exige consentimento. Ensaiado com mediasoup e P2P; Cloudflare não ensaiado com o serviço real. Ver [MEDIA-KEYS.md](MEDIA-KEYS.md).

## Atualizações

Artefatos Windows/Linux exigem manifesto Ed25519 com chave pública embutida e SHA-512 do arquivo. Verificação ocorre após download e antes de instalar, inclusive ao sair. Consulta, feed e política de avisos foram preservados. Lista de pins de produção vazia bloqueia instalação; não há chave gerada nem release publicada. Ver [configuração e limites](UPDATE-SIGNING.md).
