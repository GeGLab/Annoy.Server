# Relatório de segurança — implementação local

Data: 31/10/2026. Escopo: Annoy.Server, Annoy.Client, Annoy API Global e frontend Global disponíveis neste workspace. **Implementação em validação, sem auditoria independente. Não classificar o Annoy como totalmente seguro.**

## Resultado implementado

- Global/Local exclusivos, Global padrão, marcador de modo persistido, recusa de mudança por variável de ambiente, migração administrativa offline explícita. Falha do Global não habilita autenticação local.
- Argon2id, limitação por conta/IP e concorrência limitada de KDF. Sessões bootstrap de 5 minutos, sessões vinculadas a dispositivo de 24 horas, DPoP Ed25519, nonce do processo, replay persistido e encerramento imediato de gateways revogados.
- Identidade por instância, chaves separadas por dispositivo, endosso para novos dispositivos, código de segurança comparável fora de banda, pins persistentes, revogação e renovação MLS. Chaves privadas geradas e mantidas no cliente.
- OpenMLS em processo Rust local para DMs e grupos. Mensagens, edições, exclusões e reações cifradas. Autorizações de participação e política de histórico autenticadas pelo MLS. Entrega assíncrona, mensagens fora de ordem dentro de janela limitada e fila durável com reconciliação de épocas concorrentes.
- Anexos cifrados antes do upload com chave aleatória por arquivo, nomes e MIME dentro do payload MLS. Chaves de arquivo não atravessam IPC para o renderer.
- Cofre local cifrado, índice de chaves em shards, gravação atômica, backup cifrado sob chave de recuperação do usuário, exclusão de temporários e estados MLS dos backups exportáveis. Expiração também remove texto de filas pendentes offline.
- Escrow Global não é criado nem devolvido em novas recuperações. Cofres antigos exigem rotação no cliente com controle de concorrência. Recuperar conta não recupera automaticamente mensagens ou dispositivos MLS.
- Nenhuma mensagem nova aceita texto claro, inclusive antes da primeira ativação MLS. O cliente também bloqueia envio direto/edição/reação legível antes da requisição; respostas nativas atrasadas não sobrescrevem estado mais recente na tela. Triggers SQLite impedem a escrita por versões antigas. Histórico legado fica separado e identificado; há consulta legada paginada com anexos autenticados, cópia cifrada local, recibos assinados, planejamento, backup validado, expurgo offline e restauração seletiva.
- Electron com sandbox, contextIsolation, permissões explícitas e IPC limitado ao documento confiável da janela principal. Integrações externas não usam as chaves. Tokens persistidos fora de localStorage, usando armazenamento seguro do SO quando disponível.
- Backend com validação, limites, controle de autorização, arquivos legados autenticados, CORS restritivo, logs sanitizados e proteção de SSRF/DNS rebinding em operações Git.
- HTTPS/WSS obrigatório fora do loopback de desenvolvimento. Cliente bloqueia URLs HTTP remotas e redirecionamentos antes de enviar senha/token; emissor Global e URL pública exigem TLS. Servidor confia em encaminhamento apenas dos proxies configurados.

## Aceitação e limites

| Critério | Evidência disponível | Situação |
|---|---|---|
| Global/admin não obtêm conteúdo somente a partir do banco E2EE | Clientes Rust/HTTP/Electron, canários ausentes das tabelas/arquivos de entrega; chaves apenas nos cofres locais | Demonstrado nos cenários testados; integração não auditada |
| Forward Secrecy | Estado MLS posterior não abre mensagem consumida | Teste nativo aprovado; histórico local permanente é deliberadamente acessível com as chaves de armazenamento |
| Post-Compromise Security | Clone do estado comprometido falha após atualização honesta do membro afetado | Teste nativo aprovado; requer cessar comprometimento e processar o commit |
| Exclusão de temporários e restauração | Ausência no backup exportável, expiração de registros e fila offline, não recuperação com banco isolado | Testes aprovados no escopo de cópias do aplicativo; não cobre imagens antigas completas do dispositivo |
| SFU não lê mídia | Dois Electron reais via mediasoup e via **Cloudflare Realtime SFU real** (frames autenticam no destino, vídeo exibido, época troca ao sair): o SFU encaminha somente frames SFrame (captura por DirectTransport), destino decodifica; chamada privada P2P cifrada | **Atendido para mediasoup, Cloudflare e P2P nos testes locais.** Crate `sframe` sem auditoria. Modo transporte só com consentimento |
| Modos exclusivos e indisponibilidade Global | HTTP real, reinício, migração e Electron | Testes aprovados |
| Windows | Windows 11 Pro em VM QEMU/KVM, toolchain Rust MSVC (01/11/2026): Rust 12+6, cofre 10, unidades 33, atividade 19, Server 80 (1 skip: SIGTERM não capturável no Windows), Global 16, Electron 59 (1 skip: Cloudflare sem credenciais na VM), incluindo chamadas SFrame via mediasoup e P2P e o teste exclusivo do Windows. Logs em `evidence/windows/` | **Aprovado na VM**; instalador/assinatura não ensaiados |
| Desempenho aceitável em produção | Benchmark sintético de dois participantes e testes funcionais | Não estabelecido para grandes grupos, rede real ou SFUs |

## Validação executada

243 testes aprovados na execução integrada final em Linux (01/11/2026, incluindo mídia E2EE; a execução anterior de 231 está em `evidence/previous-validated-231/`), com um teste exclusivo de Windows não executado e um passo de maximização nativa excluído no modo isolado Hyprland/XWayland. Os dez comandos do runner terminaram com sucesso. Os testes gráficos usam somente DP-5, sem mudança de foco do monitor principal na checagem registrada. Resultados, logs e histórico das falhas corrigidas estão em [VALIDATION.md](VALIDATION.md), [VALIDATION-HISTORY.md](VALIDATION-HISTORY.md) e `evidence/`. As suítes abrangem protocolo nativo, servidor, Global, armazenamento, migração, atividade e toda a interface, incluindo dois clientes Electron reais; fixtures de interface não contam como prova criptográfica. Houve um aviso não fatal de layout ResizeObserver, mantido como risco. A execução não equivale a auditoria nem cobre todos os ambientes possíveis.

A continuação implementou somente a base de chaves de mídia: engine/snapshot isolado por chamada, exporter OpenMLS, bloqueio de chaves no outbox/backup, descarte e limpeza de buffers mutáveis do pipe. A mídia com frames SFrame continua bloqueada. Foi também verificado o conteúdo do pacote Linux e seus fuses restritivos, com recusa de pacote antigo/binário adulterado e repetição dos dez testes crypto sobre o executável Rust distribuído. Isso não valida a assinatura, o instalador ou a GUI do executável empacotado; ver [LINUX-PACKAGE.md](LINUX-PACKAGE.md).

Auditoria de dependências: npm servidor e Global sem vulnerabilidades reportadas na consulta; cliente com 15 ocorrências moderadas na cadeia de empacotamento minimatch. Cargo.lock com 174 dependências, sem vulnerabilidades reportadas e um aviso de pacote opcional não mantido. Esses resultados são datados e não constituem garantia futura. O provider OpenMLS recebeu backport de código oficial para eliminar dependências vulneráveis; sua combinação com o core e o Annoy requer revisão independente.

## Mídia E2EE (01/11/2026)

Voz, câmera, tela e chamadas privadas usam SFrame (RFC 9605) com chave base exportada de um grupo MLS por chamada; o servidor apenas sequencia commits e não possui chaves. Cada dispositivo da chamada é vinculado por assinatura da chave Ed25519 do dispositivo e verificado por todos os membros no diretório fixado. Detalhes, testes e limites em [MEDIA-KEYS.md](MEDIA-KEYS.md). Ensaios: vetor oficial RFC 9605, 6 testes do adaptador SFrame, 4 do grupo de mídia, testes de servidor do sequenciamento e de chamadas privadas, e dois testes com dois clientes Electron reais (mediasoup e P2P), com áudio mudo e dispositivos falsos.

## Operação e decisões pendentes

A auditoria independente foi adiada por orientação do responsável e continua não realizada. Windows foi executado numa VM (ver tabela); o restante da implementação e dos testes Linux prossegue. A mídia E2EE está descrita em [MEDIA-KEYS.md](MEDIA-KEYS.md).

Nenhum dado de produção foi convertido ou apagado. O operador ainda precisa executar as migrações explícitas em janela de manutenção e controlar retenção de backups legados. A verificação independente Ed25519 das atualizações foi implementada e testada com chaves sintéticas; a lista de chaves públicas de produção permanece vazia e bloqueia instalação sem assinatura confiável. Consulta/download e demais mecanismos existentes continuam presentes. Certificados de instaladores, chave de produção e ensaios reais de instalação ainda não foram fornecidos/executados; ver [assinatura de atualizações](UPDATE-SIGNING.md). Ensaios de carga, instalação assinada e auditoria (incluindo o crate `sframe`) são bloqueadores de uma declaração de conclusão integral dos requisitos.

Leia [riscos](RISKS.md) e [limitações](LIMITATIONS.md) antes de avaliar implantação. Não publicar ou tornar atualizações obrigatórias sem a autorização explícita do responsável, após a validação.
