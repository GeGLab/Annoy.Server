# Modelo de ameaças

## Ativos e fronteiras

Ativos: conteúdo, anexos, chaves de identidade e dispositivo, folhas/épocas MLS, índices locais, tokens, cofre Global de servidores, códigos de recuperação, permissões e integridade do histórico legado.

Fronteiras: renderer → preload/IPC → Electron main → processo Rust privado; cliente → HTTPS/WSS → instância; cliente → Global; cliente → armazenamento seguro do SO; servidor → SQLite/uploads; cliente/SFU/serviços externos. Rust recebe snapshots secretos por pipes locais: stdout nunca pode entrar em logs, IPC público ou telemetria.

## Adversários

| Adversário | Controle considerado | Proteção/limite |
|---|---|---|
| Vazamento isolado da instância | SQLite, uploads, backups do servidor | Conteúdo novo é ciphertext; metadados e legado continuam expostos |
| Administrador/instância maliciosa | API, diretório, ordem/entrega, membros/permissões, disponibilidade | Pins, endossos, revisão inicial e autorizações MLS impedem substituição silenciosa de identidades conhecidas; pode negar serviço e tentar enganar a primeira verificação |
| Global comprometido | Login, tokens de admissão, cofre Global cifrado, respostas | Não recebe chaves MLS; novas folhas ainda precisam de endosso. Identidades ainda não verificadas e cofres antigos com escrow têm risco separado |
| Interceptador | Tráfego, mensagens repetidas/adulteradas | TLS remoto, AEAD MLS, assinaturas, épocas, DPoP e deduplicação; tamanhos/horários continuam observáveis |
| Membro removido/dispositivo revogado | Segredos que já possuía | Não obtém novos segredos após remoção MLS concluída. Mantém cópias antigas e pode causar indisponibilidade durante recuperação |
| Renderer externo/malicioso | Página externa, iframe, navegação da janela, IPC forjado | Sandbox e validação do documento/emissor. XSS no próprio renderer confiável pode agir como o usuário e ver texto apresentado |
| Dispositivo comprometido | Memória, SO, keychain, cofre desbloqueado, captura | Fora da garantia de confidencialidade do servidor; pode ler texto e chaves atuais/armazenamento |
| Cadeia de fornecimento | Binário, atualização ou dependência adulterada | Locks, provenance do provider, verificações existentes de checksum; assinatura dos artefatos ainda pendente |

## Pressupostos

A distribuição do cliente e seu SO devem ser confiáveis. Se o adversário também controlar o frontend web Global entregue ao navegador, pode substituir JavaScript e capturar o cofre quando o usuário o abrir. A confidencialidade do cofre contra vazamento isolado do backend não protege um runtime web adulterado. Separar credenciais/deploy do frontend e backend e preferir o cliente desktop verificado para operações sensíveis. A verificação inicial é TOFU acrescida de comparação manual de código; não há transparência global de chaves. Comparar códigos por um canal independente é necessário para detectar um diretório malicioso no primeiro contato. O código de segurança representa a raiz da identidade por instância, não a mera posse de uma conta Global.

O cofre Global cifrado pela senha permite testar palpites offline com PBKDF2 do cliente se os envelopes vazarem; o pepper/Argon2 do autenticador servidor não elimina esse outro verificador. Usar senhas fortes. A chave de recuperação Global atual tem 125 bits (25 caracteres Crockford), distinta da chave de backup local de 256 bits.

As garantias de FS/PCS são do estado de protocolo, com descarte correto. Histórico permanente cifrado continua legível por seu dono; comprometer suas chaves locais de armazenamento revela o que ele reteve. PCS exige atualização honesta após o invasor perder acesso; não remove um invasor ainda presente no dispositivo nem apaga cópias já obtidas.

## Abusos e disponibilidade

Servidor pode censurar, atrasar ou separar visões. Não há consenso contra fork de um delivery service malicioso. Commit rejeitado de forma definitiva pode ser desfeito localmente antes de qualquer operação posterior; perda da resposta exige repetir idempotentemente, sem voltar uma época publicada. Revogação administrativa não substitui commit MLS. Proprietário criptográfico indisponível pode bloquear entrada/remoção de outros usuários; transferência deve ocorrer enquanto há um membro autorizado disponível.

Cliente atrasado valida certificados históricos separadamente dos destinatários atuais. Um certificado revogado em transições ainda não processadas pode bloquear recuperação; não aceitar chaves revogadas para contornar isso. Exigir recuperação/reingresso autenticado e avaliar essa situação na auditoria.

## Exclusão e dados antigos

Banco antigo, FTS, uploads, WAL, backups e exportações podem conter texto claro. Cifrar uma cópia agora não torna o passado E2EE. Expurgo local com secure_delete/VACUUM não garante limpeza de SSD, snapshots, swap, dumps ou cópias do destinatário. Backup completo antigo do dispositivo pode conter chaves que o backup exportável do Annoy deliberadamente exclui. Não há promessa de anonimato: IP, horários, topologia e vínculos permanecem observáveis.
