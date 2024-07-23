# Apache DataFusion Blog Content

This repository contains the Apache DataFusion blog content.

## Setup for Mac

Based on instructions at https://jekyllrb.com/docs/installation/macos/

```shell
brew install chruby ruby-install xz
ruby-install ruby 3.1.3
```

Note: I did not have a `~/.zshrc` file so had to create one first.

```
echo "source $(brew --prefix)/opt/chruby/share/chruby/chruby.sh" >> ~/.zshrc
echo "source $(brew --prefix)/opt/chruby/share/chruby/auto.sh" >> ~/.zshrc
echo "chruby ruby-3.1.3" >> ~/.zshrc # run 'chruby' to see actual version
```

Quit and restart terminal.

```shell
ruby -v
```
Should be `ruby 3.1.3p185 (2022-11-24 revision 1a6b16756e) [arm64-darwin23]` or similar.

```shell
gem install jekyll bundler
```

## Preview site locally

```shell
bundle exec jekyll serve
```

## Publish site

TBD, but create the html with `bundle exec jekyll build` then check the content into `asf-site` branch