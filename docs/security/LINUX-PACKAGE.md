# Validação local do pacote Linux

Foi gerado um diretório Linux x64 com electron-builder 26.18.0 e Electron 45.1.0, usando `--dir --publish never`. Não foi criado ou publicado release, instalado pacote no sistema, iniciado o Electron empacotado ou ativada atualização obrigatória. O destino é temporário; nenhum diretório de dados real foi migrado.

## Executável e compatibilidade

O pacote desativa os fuses `runAsNode`, `enableNodeOptionsEnvironmentVariable` e `enableNodeCliInspectArguments`, e ativa `onlyLoadAppFromAsar`. O verificador lê os valores no executável produzido; configuração escrita sozinha não conta como aprovação. A [documentação dos fuses Electron](https://www.electronjs.org/docs/latest/tutorial/fuses) descreve essas restrições e suas implicações.

Esses flags pertencem ao executável distribuído. O Node do npm e o SDK Electron usado nas fixtures de desenvolvimento continuam funcionando. O programa empacotado deixa de servir como interpretador Node, de aceitar `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` ou de habilitar o inspector do main por flags/sinal. Não há uso de `child_process.fork` nesses caminhos do aplicativo/updater; o serviço MLS é um executável Rust separado. Diagnóstico que precise do inspector deve usar uma build de desenvolvimento isolada. Para feeds/políticas de atualização com CA privada dependentes de `NODE_EXTRA_CA_CERTS`, usar certificado de CA pública confiável; autenticação nativa e WebRTC usam o transporte/trust store Chromium/SO. Não desabilitar validação TLS como alternativa.

O fuse de criptografia de cookies não foi alterado nesta etapa: sua ativação é uma transição de armazenamento que precisa de backup e teste dos logins de serviços externos. O cofre Annoy mantém sua proteção própria e recusa armazenamento inseguro de chaves. Não declarar que todos os cookies estão cifrados. Integridade ASAR embutida [não está disponível no Linux](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) nessa plataforma suportada pelo Electron; exigir assinatura/hash de distribuição e permissões de instalação apropriadas. Assinatura do SO, instalação, execução GUI do pacote e resistência a alterações feitas por um dispositivo comprometido não foram validadas.

## Verificação executada

`annoy-client/scripts/verify-native-package.mjs` verifica:

- Correspondência dos bundles main/preload/HTML com o build validado.
- Bytes dos módulos libsodium e de todos os módulos JavaScript jose distribuídos, além da versão e dos campos de resolução dos pacotes. Campos descritivos removidos pelo empacotador, como keywords, não são comparados byte a byte.
- Ausência de caminhos de artefatos sensíveis conhecidos, como `.env`, bancos, backups e diretórios do cofre/testes. Isso não é prova de ausência universal de segredos no código ou em todas as dependências.
- Formato/arquitetura/permissão e hash do serviço Rust contra o binário release testado.
- Estado dos quatro fuses exigidos no executável.

O pacote anterior, com fuses padrão, foi recusado. Uma cópia do binário MLS com um byte alterado também foi recusada. Os dez testes de cofre/serviço foram repetidos usando o executável Rust que saiu no pacote; não são somados novamente ao total de casos distintos. As evidências JSON registram os hashes e os limites; não há assinatura de produção validada.

## Reprodução

Com o build atual já validado e em um destino novo:

```sh
# annoy-client; este comando não publica
npx electron-builder --linux --x64 --dir --publish never --config.npmRebuild=false --config.directories.output=/caminho/temporario
node scripts/verify-native-package.mjs /caminho/temporario/linux-unpacked
ANNOY_REQUIRE_NATIVE=1 ANNOY_CRYPTO_BINARY=/caminho/temporario/linux-unpacked/resources/crypto/annoy-crypto npm run test:crypto
```

O rebuild de módulos Node foi dispensado somente nessa checagem de conteúdo: o componente nativo Annoy é compilado por Rust e os módulos de runtime selecionados são JavaScript/WASM. Os comandos de distribuição existentes foram preservados. Windows e auditoria independente seguem adiados; o workflow preparado para Linux contém essas checagens, mas não foi acionado remotamente.
