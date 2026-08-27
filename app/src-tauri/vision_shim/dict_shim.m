// System dictionary shim — Apple platforms.
//
// macOS: hand the word to Dictionary.app via the dict:// scheme.
// iOS:   present UIReferenceLibraryViewController, which is the same panel
//        the system "Look Up" menu shows, including any dictionaries the
//        user has downloaded.
//
// Both give SoloPDF a full-quality dictionary for every language Apple ships
// without bundling a byte of it. The CC-CEDICT shards we do bundle are the
// fallback for Windows/Linux (and for Chinese↔English everywhere).

#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

#if TARGET_OS_IPHONE
#import <UIKit/UIKit.h>
#else
#import <AppKit/AppKit.h>
#endif

// 0 = shown, 1 = no definition available, 2 = not supported here
int solopdf_define_word(const char *word_utf8) {
  @autoreleasepool {
    if (word_utf8 == NULL) return 2;
    NSString *word = [NSString stringWithUTF8String:word_utf8];
    if (word.length == 0) return 2;

#if TARGET_OS_IPHONE
    if (![UIReferenceLibraryViewController dictionaryHasDefinitionForTerm:word]) {
      return 1;
    }
    __block int result = 0;
    void (^present)(void) = ^{
      UIWindow *key = nil;
      for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
          if (w.isKeyWindow) { key = w; break; }
        }
        if (key) break;
      }
      UIViewController *root = key.rootViewController;
      // a presented sheet (our own dialogs) must not swallow the panel
      while (root.presentedViewController) root = root.presentedViewController;
      if (root == nil) { result = 2; return; }
      UIReferenceLibraryViewController *vc =
          [[UIReferenceLibraryViewController alloc] initWithTerm:word];
      [root presentViewController:vc animated:YES completion:nil];
    };
    if (NSThread.isMainThread) present();
    else dispatch_sync(dispatch_get_main_queue(), present);
    return result;
#else
    NSString *encoded = [word stringByAddingPercentEncodingWithAllowedCharacters:
                                  NSCharacterSet.URLPathAllowedCharacterSet];
    NSURL *url = [NSURL URLWithString:[@"dict://" stringByAppendingString:encoded]];
    if (url == nil) return 2;
    return [NSWorkspace.sharedWorkspace openURL:url] ? 0 : 1;
#endif
  }
}
