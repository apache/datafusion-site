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

This is currently a manual process. Basic steps are:

#### Check out `main` and build site
```shell
# Check out latest code
git checkout main
git pull
# build site (html is left in _site directory)
bundle exec jekyll build
```

#### Check out `asf-site` and copy content
Checkout a separate copy of `datafusion-site`

```shell
git checkout asf-site
git pull
# create a branch for the publishing
git checkout -b publish_blog
# copy content built from _site directory
cp -R ../datafusion-site/_site/* .
git commit -a -m 'Publish blog content'
```

#### Make PR, targeting the `asf-site` branch
For example, see https://github.com/apache/datafusion-site/pull/9

