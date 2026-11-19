// Native PDF printing shim — Apple platforms.
//
// macOS: PDFKit PDFDocument -> printOperationForPrintInfo:scalingMode:autoRotate:
//        Vector-sharp printing identical to Preview.app, zero WKWebView HTML
//        pagination / non-blocking overlay race conditions.
// iOS:   UIPrintInteractionController (AirPrint) with raw PDF NSData.

#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

#if TARGET_OS_IPHONE
#import <UIKit/UIKit.h>
#else
#import <AppKit/AppKit.h>
#import <PDFKit/PDFKit.h>
#endif

// 0 = presented, 1 = invalid PDF data, 2 = printing unavailable
int solopdf_print_pdf(const uint8_t *bytes, size_t len, const char *job_name_utf8) {
  @autoreleasepool {
    if (bytes == NULL || len == 0) return 1;
    NSData *data = [NSData dataWithBytes:bytes length:len];
    NSString *jobName =
        (job_name_utf8 != NULL && job_name_utf8[0] != '\0')
            ? [NSString stringWithUTF8String:job_name_utf8]
            : @"SoloPDF";

#if TARGET_OS_IPHONE
    if (![UIPrintInteractionController isPrintingAvailable]) return 2;
    if (![UIPrintInteractionController canPrintData:data]) return 1;
    __block int result = 0;
    void (^present)(void) = ^{
      UIPrintInteractionController *pic =
          [UIPrintInteractionController sharedPrintController];
      UIPrintInfo *info = [UIPrintInfo printInfo];
      info.outputType = UIPrintInfoOutputGeneral;
      info.jobName = jobName;
      pic.printInfo = info;
      pic.printingItem = data;
      [pic presentAnimated:YES completionHandler:nil];
    };
    if (NSThread.isMainThread) present();
    else dispatch_sync(dispatch_get_main_queue(), present);
    return result;
#else
    __block int result = 0;
    void (^present)(void) = ^{
      PDFDocument *pdf = [[PDFDocument alloc] initWithData:data];
      if (pdf == nil || pdf.isLocked || pdf.pageCount == 0) {
        result = 1;
        return;
      }
      NSPrintInfo *info = [[NSPrintInfo sharedPrintInfo] copy];
      [info setHorizontalPagination:NSPrintingPaginationModeFit];
      [info setVerticalPagination:NSPrintingPaginationModeFit];
      [info setHorizontallyCentered:YES];
      [info setVerticallyCentered:YES];
      NSPrintOperation *op =
          [pdf printOperationForPrintInfo:info
                              scalingMode:kPDFPrintPageScaleToFit
                               autoRotate:YES];
      if (op == nil) {
        result = 2;
        return;
      }
      [op setJobTitle:jobName];
      [op setShowsPrintPanel:YES];
      [op setShowsProgressPanel:YES];
      NSWindow *win = NSApp.keyWindow ?: NSApp.mainWindow;
      if (win != nil) {
        [op runOperationModalForWindow:win
                              delegate:nil
                        didRunSelector:NULL
                           contextInfo:NULL];
      } else {
        [op runOperation];
      }
    };
    if (NSThread.isMainThread) present();
    else dispatch_sync(dispatch_get_main_queue(), present);
    return result;
#endif
  }
}
