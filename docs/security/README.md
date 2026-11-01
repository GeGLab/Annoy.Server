# Entrega de segurança do Annoy

Implementação incremental local, 31/10/2026. Não é uma certificação nem autorização de publicação. O código integra OpenMLS para mensagens e anexos e SFrame (RFC 9605) com chaves MLS para voz, câmera, tela e chamadas privadas, ensaiado com mediasoup, Cloudflare Realtime SFU real e P2P, em Linux e numa VM Windows 11. A auditoria independente permanece pendente.

1. [Relatório e situação de aceitação](REPORT.md)
2. [Modelo de ameaças](THREAT-MODEL.md)
3. [Arquitetura criptográfica e bibliotecas](CRYPTO-ARCHITECTURE.md)
4. [Migrações e recuperação operacional](MIGRATION.md)
5. [Testes, evidências e matriz dos 20 cenários](VALIDATION.md)
6. [Limitações e compatibilidade](LIMITATIONS.md)
7. [Riscos restantes](RISKS.md)
8. [Roteiro de auditoria independente](INDEPENDENT-AUDIT.md)
9. [Etapas e arquivos alterados](IMPLEMENTATION-STAGES.md)
10. [Metadados e retenção](METADATA.md)
11. [Bibliotecas avaliadas](LIBRARY-REVIEW.md)
12. [Assinatura de atualizações](UPDATE-SIGNING.md)
13. [Inventário de código](CHANGES.json) e [hashes de documentos/evidências](SHA256SUMS.json)
14. [Histórico de falhas, correções e execuções anteriores](VALIDATION-HISTORY.md)
15. [Mídia E2EE: SFrame com chaves MLS por chamada](MEDIA-KEYS.md)
16. [Pacote Linux, binário criptográfico e fuses](LINUX-PACKAGE.md)

Os mecanismos existentes de atualização foram preservados. Não foram publicados releases, ativados avisos obrigatórios, enviados commits ou executadas migrações nos dados reais. As alterações locais anteriores foram preservadas; o inventário separa arquivos preexistentes alterados e arquivos acrescentados durante esta implementação.
