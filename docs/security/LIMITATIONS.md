# Limitações e incompatibilidades

| Recurso | Comportamento nesta implementação | Alternativa/limite |
|---|---|---|
| Clientes antigos e escrita legível | Novos POST/edições/reações legíveis retornam 409, mesmo sem grupo ativo; SQLite bloqueia versões antigas | Usar cliente MLS; arquivo legado continua legível e identificado. Edições/reações legadas são somente leitura, com bloqueio também antes de transmitir pelo cliente |
| Voz, câmera, tela, chamadas privadas | SFrame com chaves MLS por chamada por padrão; sala não mistura modos; transporte só com consentimento | Cloudflare sem ensaio real; vídeo forçado a VP8 com cabeçalho do quadro legível; clientes antigos não entram em salas cifradas. Ver MEDIA-KEYS |
| Busca de conteúdo | Índice local do que o dispositivo recebeu | Não busca mensagens cifradas que este cliente não tem; servidor continua buscando legado legível |
| Moderação | Permissões, banimento e metadados; servidor não lê payload MLS | Denúncia voluntária exige revelar seleção com consentimento. Fluxo dedicado de denúncia cifrada não foi implementado |
| Bots | Não recebem chaves implicitamente e não leem conversas MLS | Futuro bot deve ser dispositivo/participante explícito. Bots externos legados são integrações separadas |
| Importação Discord | Estrutura/cargos/permissões preservados; importação de mensagens no servidor bloqueada antes de baixar/gravar | Exportar no cliente e compartilhar como anexo cifrado, identificado como origem legada; sem conversor de histórico dedicado |
| Link previews e imagens remotas | Nenhum envio do texto MLS ao servidor para expandir links | Links e serviços externos podem revelar IP/URL ao serem abertos; não anunciar preview remoto como privado |
| Notificações E2EE | Texto genérico no SO | Conteúdo aparece apenas dentro do cliente; informações de chamada legada podem aparecer no SO |
| Novo participante | Desde entrada por padrão; encaminhamento permanente opcional pelo proprietário MLS | Temporários e segredos de épocas antigas nunca são encaminhados |
| Novo dispositivo | Requer endosso e nova folha/Welcome | Backup recupera histórico local permanente, não reanima ratchets antigos; pares online podem ser necessários para reinserção |
| Proprietário criptográfico indisponível | Entrada/remoção de outros usuários pode bloquear | Transferir propriedade enquanto autorizado; preservar histórico local. Não dar chave ao administrador para contornar |
| Histórico após revogação não processada | Clientes muito atrasados podem bloquear em certificado antigo revogado | Reingresso/recuperação autenticados; não aceitar certificado revogado silenciosamente |
| Arquivos E2EE | 64 MiB por arquivo e agregado IPC; limite da instância pode ser menor (25 MiB padrão), quota 1 GiB/usuário | Dividir/compactar no cliente ou revisar limites com nova validação; não cair para upload legível |
| Arquivos antigos grandes | Prévia cifrada local/importação assistida até 64 MiB | Download autenticado nativo legado até 500 MiB, com aviso de salvar fora do cofre |
| Backup offline | Exporta somente o que está no cofre local; anexos MLS remotos não são automaticamente arquivados | Reter ciphertext remoto enquanto necessário; não prometer backup integral de todos os anexos |
| Exclusão | Temporários excluídos de exportações; chave de registro e filas expiradas removidas; tombstones locais protegem restore no cofre atual | Backups completos antigos do dispositivo e backups permanentes anteriores à exclusão podem guardar cópias. Não há eliminação universal |
| Editor Git colaborativo | Código/credencial de operação visíveis ao servidor, aviso no editor | Git local e envio de arquivo por conversa MLS |
| Theater, integrações, avatares e perfis | Serviços/URLs/metadados não pertencem ao MLS | Não inserir conteúdo confidencial nesses recursos; abrir mídia cifrada localmente quando aplicável |
| HTTP remoto e redirecionamentos de API | Cliente recusa antes de enviar senha/token; gateway exige WSS. Servidor recusa HTTP de origem não loopback sem TLS de proxy confiável | Configurar HTTPS/WSS e origem final, inclusive em LAN; exceção HTTP só para loopback de desenvolvimento. Proxy TLS deve preservar os headers apenas de peers explicitamente confiáveis |
| Perfil de SO compartilhado | O cofre protegido pelo keychain confia na sessão desse SO; não é um isolamento entre pessoas usando o mesmo perfil | Usar contas/perfis de SO distintos e bloqueio da sessão; logout Global não substitui a segurança do dispositivo |
| Browser puro/web frontend | Não possui o processo nativo MLS do Electron | Mensagens protegidas exigem o desktop; frontend Global continua cuidando somente do cofre Global |
| Senhas/tokens no cliente sem keychain | Cofre pode usar senha Argon2id explícita; tokens de login ficam somente na memória | Novo login após reiniciar, sem persistência legível |
| Instalação/atualização | Mecanismos preservados, verificação Ed25519 obrigatória antes de instalar; sem chave de produção configurada | Releases antigos sem manifesto não instalam; bootstrap manual verificado. Authenticode e instalação real assinada ainda não validados |
| Windows | Código/CI preparados, runtime não executado nesta máquina | Executar e registrar antes de aceitar a plataforma |

Dispositivo comprometido, XSS no documento confiável, destinatário malicioso, capturas/gravações, SSD/swap/dumps e cópias fora do aplicativo permanecem fora de uma promessa de apagamento/confidencialidade do servidor. Não há anonimato absoluto, transparência global de chaves ou proteção contra toda negação de serviço.
