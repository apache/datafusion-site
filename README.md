# Apache DataFusion Web Site

Coming soon

## Mac

https://jekyllrb.com/docs/installation/macos/

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
gem install jekyll bundler
```