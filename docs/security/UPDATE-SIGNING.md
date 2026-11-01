# Assinatura de atualizações — configuração antes de release

O mecanismo electron-updater e a política de avisos existentes continuam presentes. Foi acrescentada verificação independente Ed25519 do artefato em Windows e Linux, antes de marcar o download pronto e novamente antes da instalação/saída automática. A instalação automática do cache fica desabilitada até a validação; checksum vindo do mesmo feed não substitui assinatura.

`annoy-client/src/main/update-trust.ts` contém as chaves públicas SPKI confiáveis incluídas na build. Está intencionalmente vazio: não foi fornecida chave de produção, e nenhuma foi criada. Sem chave/manifesto válidos, consultar e baixar continua possível, mas instalar é bloqueado com erro explícito. Não há fallback para artefato sem assinatura. Isso torna releases antigos sem manifesto incompatíveis com a instalação pelo cliente endurecido; uma primeira instalação manual verificada é a alternativa de bootstrap.

Uma futura revisão autorizada deve escolher custodiante/chave Ed25519, incluir apenas a chave pública no cliente e guardar a privada fora do repositório e do servidor de updates. Rotação usa keyIds e sobreposição de chaves públicas em uma release anterior. Não confiar em chaves recebidas do feed, renderer ou manifesto. Revogação de chave exige distribuir cliente confiável com novo conjunto de pins; clientes antigos não ganham essa revogação magicamente.

Ferramenta local, sem publicação:

```sh
node --experimental-strip-types scripts/sign-update.mjs ARTEFATO VERSAO linux x64 KEY_ID /offline/chave.pem DIRETORIO_EXISTENTE
```

Trocar `linux` por `win32` para o instalador Windows. A ferramenta não gera chaves e recusa sobrescrever manifesto. O arquivo `annoy-PLATAFORMA-ARQUITETURA-VERSAO.signed.json` contém versão do formato, keyId, versão, plataforma, arquitetura, nome, tamanho e SHA-512, assinados com domínio `annoy/update/artifact/v1`. Publicação futura, se autorizada, deve colocar esse arquivo junto ao artefato e metadados electron-updater no diretório da release. Feeds genéricos procuram o mesmo nome no diretório configurado e exigem HTTPS fora do loopback.

A assinatura usa Node/OpenSSL Ed25519, sem implementar uma primitiva criptográfica. As verificações rejeitam emissor desconhecido, versão/plataforma/arquitetura errada, hash/tamanho alterado, symlink, metadados divergentes e manifesto acima de 16 KiB. O controlador também recusa evento de download que não corresponda à versão solicitada e rejeita falha assíncrona de revalidação na instalação.

Testes sintéticos dessas condições passaram em Linux. Não foi testada instalação real de release assinada, nem Authenticode, SmartScreen, cadeia de certificados Windows ou assinatura de instalador no SO. Um administrador local capaz de alterar o cliente/verificador continua fora da proteção. Validar também permissões e corrida entre checagem e execução do cache no SO real.

O hook existente de recursos Windows deve ser executado antes da assinatura final; nunca editar executável assinado sem assinar novamente. A assinatura Ed25519 do artefato não é certificado Authenticode. A documentação atual do [electron-builder](https://www.electron.build/docs/features/code-signing/code-signing-win/) descreve mecanismos mais recentes; conferir a versão efetivamente fixada no lock antes de aplicar opções de outra versão.

Não foram publicados manifests, releases ou avisos críticos. `security/advisories.json` permanece sem nova ativação obrigatória. A chave pública de produção e os ensaios de instalação são pendências explícitas da entrega.
