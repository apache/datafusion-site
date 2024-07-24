# Apache DataFusion Blog Content

This repository contains the Apache DataFusion blog at https://datafusion.apache.org/blog/

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

### Preview site locally

```shell
bundle exec jekyll serve
```

## Setup for Docker

If you don't wish to change or install ruby and nodejs locally, you can use docker to build and preview the site with a command like:

```shell
docker run -v `pwd`:/datafusion-site -p 4000:4000 -it ruby bash
cd datafusion-site
gem install jekyll bundler
bundle install
# Serve using local container address
bundle exec jekyll serve --host 0.0.0.0
```

Then open http://localhost:4000/blog/ to see the blog locally

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

